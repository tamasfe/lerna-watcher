An unofficial watcher for [Lerna](https://github.com/lerna/lerna), similar to [lerna-watch](https://github.com/mattstyles/lerna-watch).

It was made with personal use in mind, but feel free to use/fork it, PRs are also welcome.

**The tool uses internal Lerna APIs and although unlikely, it might break anytime.**

- [Installation](#installation)
- [Usage](#usage)
- [Caveats](#caveats)
- [Configuration](#configuration)

## Installation

Execute the following in your Lerna root:

`yarn add --dev lerna-watcher` _(`-W` if you're using workspaces)_

or

`npm i --save-dev lerna-watcher`

## Usage

Run

`yarn lerna-watcher --help` or `npm run lerna-watcher --help`

for the available commands and options.

An example command:

`watch package-foo package-bar --stream --ignore "package-baz-*"`

This will watch for changes in packages matching `package-foo` and `package-bar` along with their local dependencies excluding any dependency matching with `package-baz-*`.

If any of the packages change, their respective commands (`package.json` scripts) will be run with Lerna, then this process is repeated for all dependents in topological order until there are no more dependents.

Forever running commands (such as web servers) are always killed with `SIGTERM` to allow graceful shutdowns and then restarted on changes.
There are no timeouts anywhere.

## Caveats

- Dependency cycles are not supported.
- Best effort ordering, commands might run multiple times, but they must always run at least once in the correct order.
- Personal focus, I add non-trivial fixes or features if I need them, the rest are up to external contributions.

## Configuration

Apart from the command line options, additional configuration can be done in `lerna.json` under the `watcher` property.

Here are the defaults with some explanation in the comments:

```json5
// lerna.json
{
  // ...
  // All of the properties are optional.
  "watcher": {
    // Stop the watching process if any of the commands fail.
    "exitOnError": false,
    // Configuration for packages.
    "packages": {
      // The default configuration for every package,
      // unless specified otherwise.
      //
      // These example values are used by default if omitted from the config.
      "default": {
        // Paths to watch relative to the package root.
        "include": ["**"],
        // Files to exclude from watching relative to the package root.
        // These override "include".
        "exclude": [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          ".*/**"
        ],
        // The commands (npm/yarn scripts) to run on change.
        // These are executed in order.
        //
        // This list must never be empty.
        "commands": ["dev"],
        // Alternatively, these commands are run when the package is
        // a dependency, "commands" and "dependencyCommands" are completely
        // independent.
        //
        // This list is allowed to be empty, and is empty by default.
        "dependencyCommands": [],
        // Additional commands to run after a specified command.
        //
        // These are always run in a fire and forget manner compared
        // to the rest, meaning they will never be cancelled and can fail,
        // but they are always executed sequentially.
        //
        // Useful for lints and tests.
        "runAfter": {
          // This doesn't exist in the default config, it's just an example command.
          "build": ["lint", "test", "something-else"]
        },
        // Continue with running the next command in case the previous one fails.
        "continueOnError": false,
        // Always ignore this package as a dependency.
        "ignore": false
      },
      // Configuration for package names by wildcard patterns.
      //
      // All package must match exactly one pattern.
      "patterns": {
        // All the properties are the same as in "default".
        //
        // For missing properties, the default ones are used.
        "foo-*": {
          // Build and start every foo when directly watched.
          "commands": ["test", "build", "start"],
          // Build and test, but don't start it if it's a dependency.
          "dependencyCommands": ["test", "build"]
        }
      }
    },
    // Caching is done to track file changes,
    // if this is set to true, the cache will be
    // cleared on exit.
    "clearCache": false
  }
}
```
