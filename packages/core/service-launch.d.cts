export function serviceLaunch(options: {
  root: string;
  executable: string;
  compiled?: boolean;
  packaged?: boolean;
}): { args: string[]; cwd: string };
