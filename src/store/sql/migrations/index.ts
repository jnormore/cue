import { sql as init } from "./001-init.js";
import { sql as artifacts } from "./002-artifacts.js";
import { sql as configs } from "./003-configs.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered list of all migrations. Append new entries — never reorder
 * or rewrite past entries, since deployed databases hold their applied
 * version in the `schema_version` table.
 */
export const migrations: Migration[] = [
  { version: 1, name: "init", sql: init },
  { version: 2, name: "artifacts", sql: artifacts },
  { version: 3, name: "configs", sql: configs },
];
