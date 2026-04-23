import { rename, writeFile } from "node:fs/promises";

export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2));
}

export function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
