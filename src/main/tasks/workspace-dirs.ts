// 任务的额外工作区目录（`/add-dir`）：状态只存在于 omp 进程里（实测不写配置，进程重启就没了），所以这里只存 omp 最近一次
// 报出来的列表，进程退出时清空。唯一来源是 omp 的输出（`/dirs`、`/add-dir`、`/remove-dir` 的 toast / command_output）
// 或主进程工具实际访问过的目录，渲染进程传来的路径从不进这个列表——文件面板按下标选根（main/files/task-roots.ts），校验靠这里的列表。
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseDirsOutput } from "../../shared/omp-output/dirs.ts";

function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInsideOrSame(childPath: string, parentPath: string): boolean {
  const child = normPath(childPath);
  const parent = normPath(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
}

/** 向上查找包含 `.git` 的仓库根目录（支持普通仓库与 git worktree 的 `.git` 文件）。 */
export function findGitRootSync(startDir: string): string | null {
  try {
    let curr = path.resolve(startDir);
    while (true) {
      if (existsSync(path.join(curr, ".git"))) return curr;
      const parent = path.dirname(curr);
      if (parent === curr) return null;
      curr = parent;
    }
  } catch {
    return null;
  }
}

const PROJECT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml"] as const;

/**
 * 从工具访问的文件或目录路径推导应当纳入任务工作区的根目录：
 * - 已在 `taskCwd` 内、或是系统临时目录时返回 `null`；
 * - 若位于某个 Git 仓库内，优先返回该 Git 仓库根目录（使跨目录编辑自动关联完整仓库）；
 * - 否则尝试向上查找常见项目清单文件，找不到则返回所在目录。
 */
export function resolveTouchedWorkspaceDir(rawPath: string, taskCwd: string): string | null {
  let cleaned = rawPath
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/#L\d+(?:-L?\d+)?.*$/i, "")
    .replace(/(?<!^[A-Za-z]):\d+(?:[:-]\d+)?$/, "")
    .trim();
  if (cleaned === "" || cleaned.startsWith("~")) return null;
  if (/^file:\/\//i.test(cleaned)) {
    try {
      cleaned = decodeURIComponent(cleaned.replace(/^file:\/\//i, ""));
    } catch {
      cleaned = cleaned.replace(/^file:\/\//i, "");
    }
    if (/^\/+[A-Za-z]:/.test(cleaned)) cleaned = cleaned.replace(/^\/+/, "");
  }

  let abs: string;
  try {
    abs = path.resolve(taskCwd, cleaned);
  } catch {
    return null;
  }

  if (isInsideOrSame(abs, taskCwd)) return null;
  const tmp = tmpdir();
  if (tmp !== "" && isInsideOrSame(abs, tmp)) return null;
  if (/appdata[/\\]local[/\\]temp|[/\\]tmp[/\\]/i.test(abs)) return null;

  let startDir: string;
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      startDir = abs;
    } else {
      const parent = path.dirname(abs);
      if (parent === abs || !existsSync(parent)) return null;
      startDir = parent;
    }
  } catch {
    return null;
  }

  const gitRoot = findGitRootSync(startDir);
  if (gitRoot !== null && !isInsideOrSame(gitRoot, taskCwd)) {
    return gitRoot;
  }

  const homeNorm = normPath(homedir());
  let curr = startDir;
  while (true) {
    const currNorm = normPath(curr);
    if (currNorm === homeNorm) break;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    if (PROJECT_MARKERS.some((marker) => existsSync(path.join(curr, marker)))) {
      return curr;
    }
    curr = parent;
  }

  return startDir;
}

export class WorkspaceDirs {
  #dirs: readonly string[] = [];

  /** 额外目录（不含任务自己的 cwd），按 omp 给的顺序。 */
  get dirs(): readonly string[] {
    return this.#dirs;
  }

  /** 进程退出：omp 那边的列表没了。返回是否有变化。 */
  reset(): boolean {
    if (this.#dirs.length === 0) return false;
    this.#dirs = [];
    return true;
  }

  /** 注册任务运行期间工具实际访问过的额外工作目录（去重、合并父子目录，忽略任务自身 cwd）。 */
  addDir(dir: string, taskCwd?: string): boolean {
    const trimmed = dir.trim();
    if (trimmed === "") return false;
    const resolved = path.resolve(trimmed);
    if (taskCwd !== undefined && isInsideOrSame(resolved, taskCwd)) return false;
    if (this.#dirs.some((existing) => isInsideOrSame(resolved, existing))) return false;
    const filtered = this.#dirs.filter((existing) => !isInsideOrSame(existing, resolved));
    this.#dirs = [...filtered, resolved];
    return true;
  }

  /**
   * 用 omp 的一条输出更新列表，返回是否有变化。omp 拒绝（目录不存在、已在工作区…）或输出认不出来时，
   * 以 omp 原文抛错，列表保持不变。
   */
  apply(output: string): boolean {
    const parsed = parseDirsOutput(output);
    if (parsed.kind === "rejected") throw new Error(parsed.message);
    if (parsed.kind === "unparsed") throw new Error(parsed.text.trim() === "" ? "omp returned no output" : parsed.text);
    const same = parsed.dirs.length === this.#dirs.length && parsed.dirs.every((dir, i) => dir === this.#dirs[i]);
    if (same) return false;
    this.#dirs = parsed.dirs;
    return true;
  }
}
