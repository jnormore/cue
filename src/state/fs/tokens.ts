import { timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  mintToken,
  type NamespaceTokenStore,
  parseTokenNamespace,
} from "../index.js";
import { validateNamespace } from "../../store/index.js";
import { isENOENT } from "../../store/fs/util.js";

const TOKEN_FILE_MODE = 0o600;

export function fsNamespaceTokens(home: string): NamespaceTokenStore {
  const tokensDir = join(home, "state", "tokens");
  const tokenFile = (namespace: string) => join(tokensDir, namespace);

  async function writeAtomic0600(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data, { mode: TOKEN_FILE_MODE });
    await chmod(tmp, TOKEN_FILE_MODE);
    await rename(tmp, path);
  }

  return {
    async resolveOrCreate(namespace: string): Promise<string> {
      validateNamespace(namespace);
      try {
        const existing = await readFile(tokenFile(namespace), "utf8");
        const trimmed = existing.trim();
        if (trimmed) return trimmed;
      } catch (err) {
        if (!isENOENT(err)) throw err;
      }
      const token = mintToken(namespace);
      await mkdir(tokensDir, { recursive: true });
      await writeAtomic0600(tokenFile(namespace), token);
      return token;
    },

    async verify(token: string): Promise<string | null> {
      const ns = parseTokenNamespace(token);
      if (!ns) return null;
      let stored: string;
      try {
        stored = (await readFile(tokenFile(ns), "utf8")).trim();
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
      if (!stored) return null;
      const a = Buffer.from(token);
      const b = Buffer.from(stored);
      if (a.length !== b.length) return null;
      return timingSafeEqual(a, b) ? ns : null;
    },

    async deleteNamespace(namespace: string): Promise<void> {
      validateNamespace(namespace);
      try {
        await rm(tokenFile(namespace));
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },
  };
}
