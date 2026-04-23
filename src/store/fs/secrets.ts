import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type SecretStore,
  validateNamespace,
  validateSecretName,
} from "../index.js";
import { isENOENT } from "./util.js";

const SECRET_FILE_MODE = 0o600;

export function fsSecrets(home: string): SecretStore {
  const secretsDir = join(home, "secrets");
  const dirFor = (namespace: string) => join(secretsDir, namespace);
  const fileFor = (namespace: string, name: string) =>
    join(dirFor(namespace), name);

  async function writeAtomic0600(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data, { mode: SECRET_FILE_MODE });
    // Re-chmod in case the umask stripped bits on some platforms.
    await chmod(tmp, SECRET_FILE_MODE);
    await rename(tmp, path);
  }

  return {
    async set(namespace, name, value) {
      validateNamespace(namespace);
      validateSecretName(name);
      const dir = dirFor(namespace);
      await mkdir(dir, { recursive: true });
      await writeAtomic0600(fileFor(namespace, name), value);
    },

    async list(namespace) {
      validateNamespace(namespace);
      try {
        const entries = await readdir(dirFor(namespace));
        return entries.filter((e) => !e.endsWith(".tmp")).sort();
      } catch (err) {
        if (isENOENT(err)) return [];
        throw err;
      }
    },

    async resolve(namespace, names) {
      validateNamespace(namespace);
      const out: Record<string, string> = {};
      for (const name of names) {
        try {
          out[name] = await readFile(fileFor(namespace, name), "utf8");
        } catch (err) {
          if (isENOENT(err)) continue;
          throw err;
        }
      }
      return out;
    },

    async delete(namespace, name) {
      validateNamespace(namespace);
      validateSecretName(name);
      try {
        await rm(fileFor(namespace, name));
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },

    async deleteNamespace(namespace) {
      validateNamespace(namespace);
      await rm(dirFor(namespace), { recursive: true, force: true });
    },
  };
}
