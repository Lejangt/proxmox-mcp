/** Returns the value of `--config <path>` or `--config=<path>`, and the remaining arguments. */
export function extractConfigPath(args: string[]): { configPath?: string; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--config') {
      const value = args[i + 1];
      if (value === undefined) throw new Error('--config needs a path');
      configPath = value;
      i++;
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else {
      rest.push(arg);
    }
  }
  return configPath === undefined ? { rest } : { configPath, rest };
}
