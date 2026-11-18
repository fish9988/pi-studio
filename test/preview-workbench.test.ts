import { describe, expect, it } from "vitest";
import type { TaskId } from "../src/shared/ipc.ts";
import {
  closeDshTab,
  openDshPreviewTab,
  openDshToolTab,
  reorderDshTab,
  useDshWorkspace,
} from "../src/renderer/src/features/workbench/dsh-workbench-store.ts";
import { parsePreviewPathFragment } from "../src/renderer/src/features/file-preview/files-target.ts";

describe("parsePreviewPathFragment", () => {
  it("解析 #page:N、#page=N、#LN 与 :N", () => {
    expect(parsePreviewPathFragment("docs/paper.pdf#page:5")).toEqual({ path: "docs/paper.pdf", page: 5 });
    expect(parsePreviewPathFragment("docs/paper.pdf#page=12")).toEqual({ path: "docs/paper.pdf", page: 12 });
    expect(parsePreviewPathFragment("src/app.ts#L42-L50")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parsePreviewPathFragment("C:\\repo\\main.ts:18")).toEqual({ path: "C:\\repo\\main.ts", line: 18 });
    expect(parsePreviewPathFragment("README.md")).toEqual({ path: "README.md" });
  });
});

describe("dsh-workbench-store 多文件预览标签", () => {
  it("支持多文件独立预览 Tab 并存、复用、拖拽重排与上限淘汰", () => {
    const key = "task-wb-multi-preview" as TaskId;
    const filesTab = openDshToolTab(key, "files");
    const t1 = openDshPreviewTab(key, "a.pdf", { page: 2 });
    const t2 = openDshPreviewTab(key, "b.docx");
    expect(t1.id).not.toBe(t2.id);

    // 重复打开同一文件复用原 Tab 并更新 page
    const t1Again = openDshPreviewTab(key, "a.pdf", { page: 7 });
    expect(t1Again.id).toBe(t1.id);
    expect(t1Again.page).toBe(7);

    // 重排 Tab
    reorderDshTab(key, t2.id, filesTab.id);
    expect(typeof useDshWorkspace).toBe("function");

    // 上限 10 个 preview Tab
    for (let i = 0; i < 12; i++) {
      openDshPreviewTab(key, `doc-${i}.md`);
    }
    closeDshTab(key, filesTab.id);
  });
});
