import { describe, expect, it } from "vitest";
import {
  classifyAssistantText,
  hasRawToolMarkup,
  splitLeakedReasoning,
  textBlockPhase,
} from "../src/shared/assistant-text-kind.ts";

// DeepSeek 原生标记用的是全角竖线 U+FF5C 和下划线式分隔符 U+2581。
const FULL = "\uFF5C";
const SEP = "\u2581";
const DS_OPEN = `<${FULL}begin${SEP}of${SEP}thinking${FULL}>`;
const DS_CLOSE = `<${FULL}end${SEP}of${SEP}thinking${FULL}>`;

describe("assistant text classifier — 把漏进正文通道的思维认出来", () => {
  it("reads the Responses API message.phase out of textSignature", () => {
    expect(textBlockPhase(JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }))).toBe("commentary");
    expect(textBlockPhase(JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }))).toBe("final_answer");
    expect(textBlockPhase(JSON.stringify({ v: 1, id: "msg_1" }))).toBeNull();
    expect(textBlockPhase(undefined)).toBeNull();
    expect(textBlockPhase("{not json")).toBeNull();
  });

  it("splits a fully tagged thinking block into reasoning only", () => {
    expect(splitLeakedReasoning("<thinking>\n先看目录\n再看文件\n</thinking>\n")).toEqual({
      reasoning: "先看目录\n再看文件",
      answer: "",
    });
  });

  it("keeps the answer that follows a leaked thinking block", () => {
    const split = splitLeakedReasoning(`${DS_OPEN}plan the edit${DS_CLOSE}\n\n改好了，三处都修了。`);
    expect(split?.reasoning).toBe("plan the edit");
    expect(split?.answer).toBe("改好了，三处都修了。");
  });

  it("treats an unclosed opening tag as reasoning to the end of the block", () => {
    expect(splitLeakedReasoning("<thinking>现在汇报。要点：1… 2…")).toEqual({
      reasoning: "现在汇报。要点：1… 2…",
      answer: "",
    });
  });

  it("treats a bare closing tag at the end as a truncated reasoning dump", () => {
    expect(splitLeakedReasoning("让我先读一下文件再改。\n</think>")).toEqual({
      reasoning: "让我先读一下文件再改。",
      answer: "",
    });
    expect(splitLeakedReasoning(`时间紧，直接写脚本。${DS_CLOSE}\n`)).toEqual({
      reasoning: "时间紧，直接写脚本。",
      answer: "",
    });
  });

  it("leaves ordinary prose that mentions thinking tags alone", () => {
    expect(splitLeakedReasoning("正文里写 `</think>` 是合法的，别乱拆。")).toBeNull();
    // 真实场景：思维正文里在讨论标签本身（标签全在行内代码里）。
    expect(splitLeakedReasoning("我们支持 ` thinking`、`<thinking>...</thinking>`、以及不成对的开标签。")).toBeNull();
    expect(splitLeakedReasoning("我先看目录，再改代码。")).toBeNull();
  });

  it("detects raw DeepSeek tool-call markup only when the block starts with it", () => {
    expect(hasRawToolMarkup(`<${FULL}DSML${FULL} calls>\n<${FULL}DSML${FULL} invoke name="write">`)).toBe(true);
    // 正文里提到标记、哪怕两处，也只是文本。
    expect(
      hasRawToolMarkup(
        `如果你在正文里看到 <${FULL}DSML${FULL} invoke name="read"> 和 <${FULL}DSML${FULL} parameter 两处标记`,
      ),
    ).toBe(false);
    expect(hasRawToolMarkup("普通正文，没有标记")).toBe(false);
  });

  it("does not mistake a backticked mention of the markup for a real leak", () => {
    // 真实回归：回答里举例说明标记长什么样，结果整段回答被当成思考。
    const answer = `更糟的时候它会把没说完的推理直接吐出来，结尾带一个裸的 \`</think>\`，甚至把 \`<${FULL}DSML${FULL} calls>\` 这种原始工具调用标记当正文发出来。`;
    expect(hasRawToolMarkup(answer)).toBe(false);
    expect(classifyAssistantText(answer, undefined)).toEqual({ kind: "answer" });
    // 写在没有反引号的句子里但只提一次名字，也不算。
    expect(classifyAssistantText(`正文里提到 ${FULL}DSML${FULL} 这个词而已`)).toEqual({ kind: "answer" });
  });

  it("never folds a block the channel marks as final_answer", () => {
    const signature = JSON.stringify({ v: 1, id: "msg_4", phase: "final_answer" });
    const answer = `结尾带一个裸的 </think>，还有 <${FULL}DSML${FULL} calls> 和 <${FULL}DSML${FULL} invoke name="read">`;
    expect(classifyAssistantText(answer, signature)).toEqual({ kind: "answer" });
  });

  it("classifies commentary phase text as process even without tags", () => {
    const signature = JSON.stringify({ v: 1, id: "msg_2", phase: "commentary" });
    expect(classifyAssistantText("现在我来看一下桥接文件。", signature)).toEqual({
      kind: "process",
      reasoning: "现在我来看一下桥接文件。",
      answer: "",
    });
    const finalSignature = JSON.stringify({ v: 1, id: "msg_3", phase: "final_answer" });
    expect(classifyAssistantText("改完了，三处都修了。", finalSignature)).toEqual({ kind: "answer" });
  });

  it("keeps plain answers as answers", () => {
    expect(classifyAssistantText("9.8 更大。", undefined)).toEqual({ kind: "answer" });
    expect(classifyAssistantText("", undefined)).toEqual({ kind: "answer" });
  });
});

describe("assistant text classifier — 正文里的尖括号 / 类标签 / snake_case 不能被吐掉", () => {
  it("keeps prose that mentions tags, generics and event names as the answer", () => {
    const bodies = [
      "And DSML text containing <...> where the tag is <tag>",
      "用 <tag> 包起来，<T> 是泛型，Array<string> 是类型，Map<K, V> 也是",
      "text_start/text_delta/text_end + message_end 是流式事件",
    ];
    for (const body of bodies) {
      expect(classifyAssistantText(body, undefined)).toEqual({ kind: "answer" });
    }
  });

  it("does not cut a block that mentions a bare closing tag in the middle", () => {
    const body = "这段讲 </thinking> 标签的行为，另一段讲思考";
    expect(splitLeakedReasoning(body)).toBeNull();
    expect(classifyAssistantText(body, undefined)).toEqual({ kind: "answer" });
  });

  it("keeps a block that merely names DSML markers as the answer", () => {
    const body = `如果你在正文里看到 <${FULL}DSML${FULL} invoke name="read"> 和 <${FULL}DSML${FULL} parameter 两处标记，说明通道没解析好`;
    expect(hasRawToolMarkup(body)).toBe(false);
    expect(classifyAssistantText(body, undefined)).toEqual({ kind: "answer" });
  });

  it("still folds a raw tool-call block that starts with the DSML marker", () => {
    const block = `<${FULL}DSML${FULL} calls>\n<${FULL}DSML${FULL} invoke name="read">`;
    expect(classifyAssistantText(block, undefined)).toEqual({
      kind: "process",
      reasoning: block,
      answer: "",
    });
  });

  it("still folds thinking that opens with a tag or ends with a bare closing tag", () => {
    expect(classifyAssistantText("<thinking>先看目录\n再看文件", undefined)).toEqual({
      kind: "process",
      reasoning: "先看目录\n再看文件",
      answer: "",
    });
    const deepSeek = `${DS_OPEN}推理${DS_CLOSE}\n\n改完了。`;
    expect(classifyAssistantText(deepSeek, undefined)).toEqual({
      kind: "process",
      reasoning: "推理",
      answer: "改完了。",
    });
    // 只有闭标签收尾、前面是推理：整块是过程，没有可见回答。
    expect(classifyAssistantText("让我先读一下文件。\n</thinking>", undefined)).toEqual({
      kind: "process",
      reasoning: "让我先读一下文件。",
      answer: "",
    });
  });

  it("still lets the channel phase win for commentary and final_answer", () => {
    const commentary = JSON.stringify({ v: 1, id: "msg_5", phase: "commentary" });
    const finalAnswer = JSON.stringify({ v: 1, id: "msg_6", phase: "final_answer" });
    expect(classifyAssistantText("现在我来看一下桥接文件。", commentary)).toEqual({
      kind: "process",
      reasoning: "现在我来看一下桥接文件。",
      answer: "",
    });
    expect(classifyAssistantText("这段讲 </thinking> 标签。", finalAnswer)).toEqual({ kind: "answer" });
  });
});
