// 枚举本机全部已安装字体家族（通过 Chromium Local Font Access API: window.queryLocalFonts()），
// 主进程已在 security.ts 仅对应用主框架放行 local-fonts 权限；若当前运行环境不支持则安全退回 document.fonts。
import { useEffect, useState } from "react";

interface LocalFontEntry {
  family: string;
}

interface WindowWithLocalFonts extends Window {
  queryLocalFonts?: () => Promise<readonly LocalFontEntry[]>;
}

let cachedFonts: readonly string[] | null = null;
let inflight: Promise<readonly string[]> | null = null;

function collectLoadedDocumentFonts(): string[] {
  const names = new Set<string>();
  try {
    for (const face of document.fonts) {
      const clean = face.family.replace(/^["']|["']$/g, "").trim();
      if (clean !== "") names.add(clean);
    }
  } catch {
    // 忽略受限环境异常
  }
  return [...names];
}

export async function loadInstalledFonts(force = false): Promise<readonly string[]> {
  if (!force && cachedFonts !== null) return cachedFonts;
  if (!force && inflight !== null) return inflight;

  inflight = (async () => {
    const families = new Set<string>(collectLoadedDocumentFonts());
    try {
      const query = (window as WindowWithLocalFonts).queryLocalFonts;
      if (typeof query === "function") {
        const list = await query();
        for (const item of list) {
          const clean = item.family.trim();
          if (clean !== "") families.add(clean);
        }
      }
    } catch {
      // 无权限或无头环境，保留 document.fonts 收集结果
    }
    const sorted = [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    cachedFonts = sorted;
    inflight = null;
    return sorted;
  })();

  return inflight;
}

export function useInstalledFonts(): { fonts: readonly string[]; loading: boolean; refresh(): void } {
  const [fonts, setFonts] = useState<readonly string[]>(() => cachedFonts ?? []);
  const [loading, setLoading] = useState(cachedFonts === null);

  useEffect(() => {
    let active = true;
    void loadInstalledFonts().then((list) => {
      if (!active) return;
      setFonts(list);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const refresh = () => {
    setLoading(true);
    void loadInstalledFonts(true).then((list) => {
      setFonts(list);
      setLoading(false);
    });
  };

  return { fonts, loading, refresh };
}
