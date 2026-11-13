// studio 自己的标题块：像素标志 + 版本号。TSP 过程区顶部（TspView，compact 一条低矮横条，跟着对话一起滚走）用；
// TSP 里 omp 自己的欢迎块（omp.welcome）不画，由它顶替。新任务页不用它（只画 π，见 EmptyMark）。
// 不写任务的文件夹：Composer 工具行的文件夹标签（composer-folder）一直写着（2026-10-29 仓库所有者：删掉重复的）。
import type { ReactNode } from "react";
import { useAppInfo } from "../../store/index.ts";
import { PixelLogo } from "../../ui/PixelLogo.tsx";
import "./empty.css";

interface StudioHeaderProps {
  compact?: boolean;
  children?: ReactNode;
}

/** compact 用 2 倍单位：PixelLogo 里 unit <= 2 走纯文字 lockup（π + pi studio），不再画 3px 一格的像素块，标题条更矮。 */
const COMPACT_UNIT = 2;

export function StudioHeader({ compact = false, children }: StudioHeaderProps) {
  const version = useAppInfo()?.version ?? null;
  return (
    <div className="empty-hero" data-testid="studio-header" data-compact={compact ? "" : undefined}>
      <PixelLogo version={version} {...(compact ? { unit: COMPACT_UNIT } : {})} />
      {children}
    </div>
  );
}
