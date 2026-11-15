// 菜单用的内联 SVG 图标（不引图标库）。16×16 栅格，描边 --icon-stroke，颜色跟随 currentColor。
import type { ReactNode } from "react";

function Icon({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="var(--icon-stroke)"
      className="icon"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export interface IconProps {
  size?: number;
}

/** 切换侧栏：16×16 栅格，与右侧工作台图标同粗细同圆角；侧栏显示时左栏填满，收起时只剩分隔线。 */
export function SidebarIcon({ size = 16, shown }: IconProps & { shown: boolean }) {
  return (
    <Icon size={size}>
      <rect
        className="sidebar-icon-fill"
        data-shown={shown}
        x="2.9"
        y="3.8"
        width="2.3"
        height="8.4"
        rx="0.6"
        fill="currentColor"
        stroke="none"
      />
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <path d="M5.75 2.5v11" />
    </Icon>
  );
}
