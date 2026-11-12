import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { revertSessionFileChangesFromJsonl } from "../src/main/pi/revert-session-files.ts";

describe("revertSessionFileChangesFromJsonl", () => {
  it("reverts edit and newly written files from target user entry onward while keeping earlier changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-studio-revert-"));
    try {
      const fileA = path.join(dir, "a.ts");
      const fileB = path.join(dir, "created-later.ts");
      await writeFile(fileA, "export const x = 3;\n", "utf8");
      await writeFile(fileB, "export const created = true;\n", "utf8");

      const jsonl = [
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          message: { role: "user", content: [{ type: "text", text: "first turn" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "edit",
                arguments: { path: "a.ts", oldText: "export const x = 1;", newText: "export const x = 2;" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "r1",
          parentId: "a1",
          message: { role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [] },
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: "r1",
          message: { role: "user", content: [{ type: "text", text: "second turn to undo" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a2",
          parentId: "u2",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc2",
                name: "edit",
                arguments: { path: "a.ts", oldText: "export const x = 2;", newText: "export const x = 3;" },
              },
              {
                type: "toolCall",
                id: "tc3",
                name: "write",
                arguments: { path: "created-later.ts", content: "export const created = true;\n" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "r2",
          parentId: "a2",
          message: { role: "toolResult", toolCallId: "tc2", toolName: "edit", content: [] },
        }),
        JSON.stringify({
          type: "message",
          id: "r3",
          parentId: "r2",
          message: { role: "toolResult", toolCallId: "tc3", toolName: "write", content: [] },
        }),
      ].join("\n");

      const reverted = await revertSessionFileChangesFromJsonl(jsonl, "u2", dir);
      expect(reverted).toBe(2);
      expect(await readFile(fileA, "utf8")).toBe("export const x = 2;\n");
      const bExists = await stat(fileB).then(
        () => true,
        () => false,
      );
      expect(bExists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
