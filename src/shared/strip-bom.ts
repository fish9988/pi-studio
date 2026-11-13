/** 剥离文本开头可能存在的 UTF-8 BOM（避免 Windows 编辑器写入的配置触发 JSON.parse 异常）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
