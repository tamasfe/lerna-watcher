import log from "npmlog";
// @ts-ignore
import Project from "@lerna/project";
// @ts-ignore
import PackageGraph from "@lerna/package-graph";
// @ts-ignore
import Package from "@lerna/package";
import yargs from "yargs/yargs";
// @ts-ignore
import yargsHelpers from "yargs/helpers";
// @ts-ignore
import filterLernaPackages from "@lerna/filter-packages";
import deepmerge from "deepmerge";
import { exit } from "process";
import chokidar from "chokidar";
import debounce from "lodash.debounce";
import { ChildProcess, spawn } from "child_process";
import AsyncLock from "async-lock";
import path from "path";
import { isMatch } from "matcher";
import crypto, { BinaryLike } from "crypto";
import fs from "fs/promises";
import fsOld, { FSWatcher } from "fs";
import { tmpdir } from "os";


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
   * Additional commands to run after a specified command.
   *
   * These are always run in a fire and forget manner.
   *
   * Useful for lints and tests.
   */
  runAfter?: Record<string, Array<string>>;

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
   * Whether to clear cache on exit.
   */
  clearCache?: boolean;
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
        .option("run", {
          type: "boolean",
          default: false,
          description: `Run the commands of the watched main packages at startup, this is ignored if "--run-all" is used.`,
        })
        .option("run-all", {
          type: "boolean",
          default: false,
          description: `Run the commands of all the packages (including dependencies) at startup.`,
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
    (all: any, p: any) => ({ ...all, [(p as any).name]: p }),
    {}
  );

  if ((argv.packages?.length ?? 0) === 0) {
    console.log("Packages must be specified.");
    exit(1);
  }

  const mainPackages = silent(() => filterPackages(packages, argv.packages));
  const ignoredPackages =
    (argv.ignore?.length ?? 0) > 0
      ? silent(() => filterPackages(packages, argv.ignore))
      : [];

  if (mainPackages.length === 0) {
    getLog().error("watch", "no packages found.");
    exit(1);
  }

  const ignoredPackagesMap: Record<string, Package> = ignoredPackages.reduce(
    (all, p) => ({ ...all, [(p as any).name]: p }),
    {}
  );

  const packageGraph = new PackageGraph(
    packages,
    argv.dev ? "allDependencies" : "dependencies",
    true
  );

  packageGraph.collapseCycles(true);

  const tmpDir = path.join(tmpdir(), "lerna-watch");

  fsOld.mkdirSync(tmpDir, { recursive: true });
  if (watchConfig.clearCache) {
    process.once("exit", () => {
      fsOld.rmSync(tmpDir, { recursive: true, force: true });
    });
  }

  PackageWatch.options = {
    watchConfig,
    tmpDir,
    ignoredPackages: ignoredPackagesMap,
    packages: packagesMap,
    argv,
    packageGraph,
  };

  mainPackages.forEach(p => new PackageWatch(p));
}
main();

interface PackageWatchGlobalOptions {
  watchConfig: WatchConfig;
  argv: any;
  tmpDir: string;
  packageGraph: PackageGraph;
  ignoredPackages: Record<string, Package>;
  packages: Record<string, Package>;
}

interface PackageFsWatcher {
  watcher: FSWatcher;
  callbacks: Array<(firstRun?: boolean) => void>;
  isReady: boolean;
}

class PackageWatch {
  public static options: PackageWatchGlobalOptions;

  private static lock = new AsyncLock();
  private static all: Record<string, PackageWatch> = {};
  private static watchers: Record<string, PackageFsWatcher> = {};

  private _name: string;

  public get name() {
    return this._name;
  }

  private isDependency: boolean;
  private commands: string[];
  private watchConfig: PackageWatchConfig;
  private tmpDirPath: string;
  private dependencyCount: number = 0;

  private process?: ChildProcess;
  private cancelled: boolean = false;

  constructor(
    private lernaPackage: Package,
    private dependents: PackageWatch[] = []
  ) {
    this._name = lernaPackage.name;
    this.isDependency = dependents.length !== 0;
    this.tmpDirPath = PackageWatch.options.tmpDir;

    this.watchConfig = getPackageWatchConfig(
      PackageWatch.options.watchConfig,
      this.name
    );

    this.commands = this.isDependency
      ? this.watchConfig.dependencyCommands ?? []
      : this.watchConfig.commands ?? [];

    if (this.commands.length === 0) {
      if (this.isDependency) {
        getLog().verbose(
          "dependency",
          `missing dependency commands for package "${this.name}"`
        );
      } else {
        getLog().error(
          "invalid config",
          `missing commands for package "${this.name}"`
        );
        exit(1);
      }
    }

    PackageWatch.all[this.name] = this;

    const toWatch: string[] = [];

    for (const dep of PackageWatch.options.packageGraph.get(this.name)
      .localDependencies) {
      const depName = dep[1].name;
      const depCfg = getPackageWatchConfig(
        PackageWatch.options.watchConfig,
        depName
      );

      if (PackageWatch.options.ignoredPackages[depName] || depCfg.ignore) {
        getLog().notice("dependency", `(ignored) "${this.name}" => "${depName}"`);
        continue;
      }
      getLog().notice("dependency", `"${this.name}" => "${depName}"`);
      toWatch.push(depName);
    }

    this.dependencyCount = toWatch.length;

    this.watchPaths();

    toWatch.forEach(
      name =>
        new PackageWatch(PackageWatch.options.packages[name], [
          ...this.dependents,
          this,
        ])
    );
  }

  public async execute() {
    if (PackageWatch.lock.isBusy(this.name)) {
      this.cancel();
    }

    await PackageWatch.lock.acquire(this.name, async () => {
      // In case there were any pending processes.
      this.cancel();

      this.cancelled = false;

      // To allow cancellation without
      // starting processes in case of
      // multiple fast invocations.
      await sleep(50);

      if (this.cancelled) {
        getLog().silly("run", `cancelled run for package "${this.name}"`);
        return;
      }

      const { argv } = PackageWatch.options;

      if (argv.bootstrap) {
        getLog().info("run", `bootstrap for for package "${this.name}"`);
        this.process = spawn(
          "./node_modules/.bin/lerna",
          [
            "bootstrap",
            "--exclude-dependents",
            "--scope",
            this.name,
            ...(argv.loglevel === "verbose" || argv.loglevel === "silly"
              ? ["--loglevel", argv.loglevel]
              : ["--loglevel", "warn"]),
          ],
          {
            stdio: "inherit",
          }
        );
        await asyncProcess(this.process);
      }

      for (const command of this.commands) {
        if (this.cancelled) {
          getLog().silly(
            "run",
            `cancelled command "${command}" for package "${this.name}"`
          );
          return;
        }

        getLog().info("run", `command "${command}" for package "${this.name}"`);

        this.process = spawn(
          "./node_modules/.bin/lerna",
          [
            "run",
            command,
            "--scope",
            this.name,
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

        const exitCode = await asyncProcess(this.process);

        if (!this.cancelled && exitCode !== 0) {
          if (PackageWatch.options.watchConfig.exitOnError) {
            getLog().error(
              "run",
              `command "${command}" failed for package "${this.name}"`
            );
            exit(1);
          } else {
            getLog().warn(
              "run",
              `command "${command}" failed for package "${this.name}"`
            );
            if (!this.watchConfig.continueOnError) {
              break;
            }
          }
        } else {
          getLog().info(
            "run",
            `command "${command}" finished for package "${this.name}"`
          );

          const afterCommands = this.watchConfig.runAfter?.[command];

          const pkgName = this.name;

          if (afterCommands) {
            (async () => {
              for (const command of afterCommands) {
                getLog().info(
                  "run",
                  `additional command "${command}" for package "${pkgName}"`
                );
                const child = spawn(
                  "./node_modules/.bin/lerna",
                  [
                    "run",
                    command,
                    "--scope",
                    pkgName,
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

                const onExit = () => {
                  if (!child.killed) {
                    child.kill();
                  }
                };

                process.on("exit", onExit);
                child.on("exit", () => process.off("exit", onExit));

                await asyncProcess(child);
              }
            })();
          }
        }
      }
    });

    // We make sure to run dependents after this package in case
    // this was cancelled by another watch.
    await PackageWatch.lock.acquire(this.name, async () => {});

    for (const dependent of this.dependents.slice().reverse()) {
      dependent.execute();
    }
  }

  private cancel() {
    this.cancelled = true;
    this.process?.kill();
    this.process = undefined;
  }

  private watchPaths() {
    if (this.watchConfig!.include!.length === 0) {
      getLog().warn("watch", `no watch paths given for package "${this.name}"`);
    }

    const executeDebounced = debounce((firstRun?: boolean) => {
      if (!firstRun) {
        getLog().info("changed", this.name);
      }
      this.execute();
    }, 500);

    const watchPaths = this.watchConfig!.include!.map(inc =>
      path.normalize(`${this.lernaPackage.location}/${inc}`)
    );

    getLog().verbose("watch", watchPaths as any);

    let pWatcher = this.getWatcher();

    if (!pWatcher) {
      getLog().info("watch", this.name);
      pWatcher = {
        watcher: chokidar.watch(watchPaths, {
          ignored: this.watchConfig.exclude,
        }),
        callbacks: [],
        isReady: false,
      };
      this.setWatcher(pWatcher);
    }

    pWatcher.callbacks.push(executeDebounced);

    const setupWatch = () => {
      // Start execution on leaf packages
      if (PackageWatch.options.argv.runAll && this.dependencyCount === 0) {
        pWatcher!.callbacks.forEach(cb => cb(true));
        // Otherwise run on only the roots
      } else if (PackageWatch.options.argv.run && !this.isDependency) {
        pWatcher!.callbacks.forEach(cb => cb(true));
      }

      const tmpDirPath = this.tmpDirPath;

      // Change is special, we have to keep track of file contents,
      // as some tools will update the file even if nothing has changed
      // resulting in endless loops.
      pWatcher!.watcher!.on("change", async p => {
        getLog().verbose("event", "change", p);
        const pathHash = hash(p);

        const tmpFilePath = path.join(tmpDirPath, pathHash);

        try {
          const oldContentHash = await fs.readFile(tmpFilePath, "utf-8");
          const newContentHash = hash(await fs.readFile(p));

          await fs.writeFile(tmpFilePath, newContentHash, "utf-8");
          if (oldContentHash !== newContentHash) {
            pWatcher!.callbacks.forEach(cb => cb());
          }
        } catch (e) {
          await fs.writeFile(tmpFilePath, hash(await fs.readFile(p)), "utf-8");
          pWatcher!.callbacks.forEach(cb => cb());
        }
      });

      ["add", "addDir", "unlink", "unlinkDir"].forEach(event =>
        pWatcher!.watcher.on(event, (p: string) => {
          getLog().verbose("event", event, p);
          pWatcher!.callbacks.forEach(cb => cb());
        })
      );
    };

    if (pWatcher.isReady) {
      setupWatch();
    } else {
      pWatcher.watcher.once("ready", setupWatch);
    }
  }

  private getWatcher(): PackageFsWatcher | undefined {
    if (PackageWatch.watchers[this.name]) {
      return PackageWatch.watchers[this.name];
    }
  }

  private setWatcher(watcher: PackageFsWatcher) {
    PackageWatch.watchers[this.name] = watcher;
  }
}

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
        commands: [],
        dependencyCommands: [],
        runAfter: {},
      },
      patterns: {},
    },
  };
}

function createWatchConfig(config?: LernaConfig): WatchConfig {
  const watchConfig: WatchConfig = deepmerge(
    defaultWatchConfig(),
    config?.watcher ?? {},
    {
      arrayMerge: (_target: any, source: any) => source,
    }
  );

  for (const packageName of Object.keys(watchConfig.packages!.patterns!)) {
    watchConfig.packages!.patterns![packageName] = deepmerge(
      watchConfig.packages!.default!,
      watchConfig.packages!.patterns![packageName],
      {
        arrayMerge: (_target: any, source: any) => source,
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
  if (watchConfig.packages?.patterns) {
    for (const pattern of Object.keys(watchConfig.packages.patterns)) {
      if (isMatch(name, pattern)) {
        if (typeof found !== "undefined") {
          getLog().error(
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

  return found ?? watchConfig.packages!.default!;
}

function asyncProcess(child: ChildProcess): Promise<number> {
  return new Promise(function (resolve, reject) {
    child.addListener("error", reject);
    child.addListener("exit", resolve);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hash(content: string | BinaryLike): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getLog(): typeof log {
  log.heading = "watcher";
  return log;
}

