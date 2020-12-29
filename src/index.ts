import log from "npmlog";
import Project from "@lerna/project";
import PackageGraph from "@lerna/package-graph";
import Package from "@lerna/package";
import yargs from "yargs/yargs";
import yargsHelpers from "yargs/helpers";
import filterLernaPackages from "@lerna/filter-packages";
import deepmerge from "deepmerge";
import { exit } from "process";
import chokidar from "chokidar";
import debounce from "lodash.debounce";
import { ChildProcess, spawn } from "child_process";
import AsyncLock from "async-lock";
import path from "path";
import { isMatch } from "matcher";

export interface PackageWatchConfig {
  /**
   * The commands to run for the main watched packages.
   *
   * The commands are run in order.
   */
  commands?: Array<string>;

  /**
   * Whether to continue executing the next command if one of them fails.
   */
  continueOnError?: boolean;

  /**
   * The commands to run when the package is a dependency.
   *
   * The commands are run in order.
   */
  dependencyCommands?: Array<string>;

  /**
   * A list of glob patterns.
   */
  include?: Array<string>;

  /**
   * A list of glob patterns.
   */
  exclude?: Array<string>;

  /**
   * Always ignore this package as a dependency.
   */
  ignore?: boolean;
}

export interface LernaConfig {
  packages?: string[];
  npmClient?: "yarn" | "npm";
  useWorkspaces?: boolean;
  version?: string | "independent";
  watcher?: WatchConfig;
}

export interface WatchConfig {
  /**
   * Whether to stop watching if a script fails.
   */
  exitOnError?: boolean;
  /**
   * Configuration for packages.
   */
  packages?: {
    /**
     * Default package configuration.
     */
    default?: PackageWatchConfig;
    /**
     * Individual package configurations.
     *
     * The names support wildcards.
     */
    patterns?: { [key: string]: PackageWatchConfig };
  };
}

async function main() {
  const argv = yargs(yargsHelpers.hideBin(process.argv))
    .command("watch [packages..]", "Watch the selected packages.", yargs => {
      yargs
        .positional("packages", {
          describe: "selected packages",
          type: "string",
          array: true,
        })
        .option("ignore", {
          type: "string",
          array: true,
          description: "Ignore the selected package dependencies.",
        })
        .option("dev", {
          type: "boolean",
          default: false,
          description: "Include dev dependencies.",
        })
        .option("stream", {
          type: "boolean",
          default: false,
          description: `Same as Lerna's "--stream" option`,
        })
        .option("no-prefix", {
          type: "boolean",
          default: false,
          description: `Same as Lerna's "--no-prefix" option`,
        })
        .option("bootstrap", {
          type: "boolean",
          default: false,
          description: `Run Lerna "bootstrap" before running commands for a package.`,
        })
        .demandOption("packages", "Packages are required.");
    })
    .option("loglevel", {
      description: "Set the logging level.",
      type: "string",
      default: "info",
    })
    .strict()
    .demandCommand().argv as any;

  if (argv.loglevel) {
    log.level = argv.loglevel;
  }

  const project = new Project();
  const config: LernaConfig = project.config;

  const watchConfig: WatchConfig = createWatchConfig(config);

  const packages = await project.getPackages();
  const packagesMap: Record<string, Package> = packages.reduce(
    (all, p) => ({ ...all, [(p as any).name]: p }),
    {}
  );

  if (argv.packages?.length ?? 0 === 0) {
    console.log("Packages must be specified.");
    exit(1);
  }

  const mainPackages = silent(() => filterPackages(packages, argv.packages));
  const ignoredPackages =
    argv.ignore?.length ?? 0 > 0
      ? silent(() => filterPackages(packages, argv.ignore))
      : [];

  if (mainPackages.length === 0) {
    log.error("watch", "no packages found.");
    exit(1);
  }

  const ignoredPackagesMap: Record<string, Package> = ignoredPackages.reduce(
    (all, p) => ({ ...all, [(p as any).name]: p }),
    {}
  );

  const graph = new PackageGraph(
    packages,
    argv.dev ? "allDependencies" : "dependencies",
    true
  );

  graph.collapseCycles(true);

  const packageLock = new AsyncLock();

  interface PackageProcess {
    process?: ChildProcess;
    cancelled: boolean;
  }

  const packageProcesses: Map<string, PackageProcess> = packages.reduce(
    (map, p) => {
      map.set(p.name, { cancelled: false, process: undefined });
      return map;
    },
    new Map()
  );

  function watchPackage(p: Package, dependents: DependentCallback[] = []) {
    const packageName: string = (p as any).name;
    log.info("watch", packageName);

    const packageCfg = getPackageWatchConfig(watchConfig, packageName);

    const isDependency = dependents.length !== 0;

    const commands = isDependency
      ? packageCfg.dependencyCommands ?? []
      : packageCfg.commands ?? [];

    if (commands.length === 0) {
      if (isDependency) {
        log.verbose(
          "dependency",
          `missing dependency commands for package "${packageName}"`
        );
      } else {
        log.error(
          "invalid config",
          `missing commands for package "${packageName}"`
        );
        exit(1);
      }
    }

    const includePaths = packageCfg.include;

    if (includePaths.length === 0) {
      log.warn("watch", `no paths given for package "${packageName}"`);
    }

    async function execute() {
      const current = packageProcesses.get(packageName);

      if (packageLock.isBusy(packageName)) {
        current.cancelled = true;
        current.process?.kill("SIGTERM");
      }

      await packageLock.acquire(packageName, async () => {
        current.cancelled = false;
        current.process?.kill();
        current.process = undefined;

        // To allow cancellation without
        // starting processes in case of
        // multiple fast invocations.
        await sleep(50);

        if (current.cancelled) {
          log.silly("run", `cancelled run for package "${packageName}"`);
          return;
        }

        if (argv.bootstrap) {
          log.info("run", `bootstrap for for package "${packageName}"`);
          current.process = spawn(
            "./node_modules/.bin/lerna",
            [
              "bootstrap",
              "--exclude-dependents",
              "--scope",
              packageName,
              ...(argv.loglevel === "verbose" || argv.loglevel === "silly"
                ? ["--loglevel", argv.loglevel]
                : ["--loglevel", "warn"]),
            ],
            {
              stdio: "inherit",
            }
          );
          await asyncProcess(current.process);
        }

        for (const command of commands) {
          if (current.cancelled) {
            log.silly(
              "run",
              `cancelled command "${command}" for package "${packageName}"`
            );
            return;
          }

          log.info("run", `command "${command}" for package "${packageName}"`);

          current.process = spawn(
            "./node_modules/.bin/lerna",
            [
              "run",
              command,
              "--scope",
              packageName,
              ...(argv.stream ? ["--stream"] : []),
              ...(argv.noPrefix ? ["--no-prefix"] : []),
              ...(argv.loglevel === "verbose" || argv.loglevel === "silly"
                ? ["--loglevel", argv.loglevel]
                : ["--loglevel", "warn"]),
            ],
            {
              stdio: "inherit",
            }
          );

          const exitCode = await asyncProcess(current.process);

          if (!current.cancelled && exitCode !== 0) {
            if (watchConfig.exitOnError) {
              log.error(
                "run",
                `command "${command}" failed for package "${packageName}"`
              );
              exit(1);
            } else {
              log.warn(
                "run",
                `command "${command}" failed for package "${packageName}"`
              );
              if (!packageCfg.continueOnError) {
                break;
              }
            }
          } else {
            log.info(
              "run",
              `command "${command}" finished for package "${packageName}"`
            );
          }

          if (current.cancelled) {
            log.silly(
              "run",
              `cancelled command "${command}" for package "${packageName}"`
            );
            return;
          }
        }
      });

      for (const dependentCallback of dependents.slice().reverse()) {
        dependentCallback();
      }
    }

    const executeDebounced = debounce(() => {
      log.info("changed", packageName);
      execute();
    }, 500);

    const watchPaths = includePaths.map(inc =>
      path.normalize(`${(p as any).location}/${inc}`)
    );

    log.verbose("watching", watchPaths as any);

    const watcher = chokidar.watch(watchPaths, {
      ignored: packageCfg.exclude,
    });

    watcher.once("ready", () => {
      ["add", "addDir", "change", "unlink", "unlinkDir"].forEach(event =>
        watcher.on(event, e => {
          log.verbose("event", event, e);
          executeDebounced();
        })
      );
    });

    // Done twice for nicer logging.
    for (const dep of graph.get(packageName).localDependencies) {
      const depName = dep[1].name;
      const depCfg = getPackageWatchConfig(watchConfig, depName);
      if (ignoredPackagesMap[depName] || depCfg.ignore) {
        log.notice("dependency", `(ignored) "${packageName}" => "${depName}"`);
        continue;
      }
      log.notice("dependency", `"${packageName}" => "${depName}"`);
    }

    for (const dep of graph.get(packageName).localDependencies) {
      const depName = dep[1].name;
      if (ignoredPackagesMap[depName]) {
        continue;
      }
      watchPackage(packagesMap[depName], [...dependents, execute]);
    }
  }

  mainPackages.forEach(p => watchPackage(p, []));
}

main();

function filterPackages(
  packages: Package[],
  include: string[],
  exclude: string[] = []
): Package[] {
  return filterLernaPackages(packages, include, exclude, true, true);
}

function silent<T>(fn: () => T): T {
  const level = log.level;
  log.level = "silent";
  const result = fn();
  log.level = level;
  return result;
}

function defaultWatchConfig(): WatchConfig {
  return {
    exitOnError: false,
    packages: {
      default: {
        ignore: false,
        continueOnError: false,
        exclude: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          ".*/**",
        ],
        include: ["**"],
        commands: ["dev"],
        dependencyCommands: [],
      },
      patterns: {},
    },
  };
}

function createWatchConfig(config?: LernaConfig): WatchConfig {
  const watchConfig: WatchConfig = deepmerge(
    defaultWatchConfig(),
    config.watcher ?? {}
  );

  for (const packageName of Object.keys(watchConfig.packages.patterns)) {
    watchConfig.packages.patterns[packageName] = deepmerge(
      watchConfig.packages.default,
      watchConfig.packages.patterns[packageName],
      {
        arrayMerge: (_target, source) => source,
      }
    );
  }

  return watchConfig;
}

function getPackageWatchConfig(
  watchConfig: WatchConfig,
  name: string
): PackageWatchConfig {
  let foundPattern = undefined;
  let found = undefined;
  if (watchConfig.packages.patterns) {
    for (const pattern of Object.keys(watchConfig.packages.patterns)) {
      if (isMatch(name, pattern)) {
        if (typeof found !== "undefined") {
          log.error(
            "invalid config",
            `multiple matches found for package "${name}": "${foundPattern}" and "${pattern}"`
          );
          exit(1);
        }

        found = watchConfig.packages.patterns[pattern];
        foundPattern = pattern;
      }
    }
  }

  return found ?? watchConfig.packages!.default;
}

function asyncProcess(child: ChildProcess): Promise<number> {
  return new Promise(function (resolve, reject) {
    child.addListener("error", reject);
    child.addListener("exit", resolve);
  });
}

type DependentCallback = () => any;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
