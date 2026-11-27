/**
 * 文本测量与换行。
 * - CanvasTextMeasurer：浏览器里用 Canvas 2D measureText，结果与实际绘制一致。
 * - HeuristicTextMeasurer：Node/CLI/测试环境下的确定性估算
 *   （中文全角≈fontSize，西文≈0.55*fontSize），不依赖 DOM。
 */
import type { LabelStyle } from './model.js';

export interface TextMeasurement {
  width: number;
  height: number;
  lines: string[];
}

export interface TextMeasurer {
  measure(text: string, style: LabelStyle): TextMeasurement;
}

/** 把文本拆成 token：连续的非空白 ASCII 视为一个不拆行的单词，其余逐字符处理。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  const isWordChar = (ch: string) => /[!-~]/.test(ch) && ch !== ' ';
  for (const ch of text) {
    if (isWordChar(ch)) {
      word += ch;
    } else {
      if (word) {
        tokens.push(word);
        word = '';
      }
      tokens.push(ch); // 空白、换行、中文等各自成 token
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

/** 贪心换行：在 maxTextWidth 内尽量多放；显式换行符强制断行。 */
export function wrapText(
  text: string,
  style: LabelStyle,
  measureWidth: (s: string) => number,
): string[] {
  const maxWidth = style.maxTextWidth;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    const flush = () => {
      lines.push(line);
      line = '';
    };
    for (const token of tokenize(paragraph)) {
      if (token === ' ') {
        // 行首空格直接丢弃
        if (line && measureWidth(line + ' ') <= maxWidth) line += ' ';
        continue;
      }
      const candidate = line + token;
      if (measureWidth(candidate) <= maxWidth || line === '') {
        // 单个超长英文单词也只能硬放，绘制层允许它撑大标签
        line = candidate;
      } else {
        flush();
        line = token;
      }
    }
    flush();
  }
  return lines;
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    // 全角（含中文、中文标点）≈ 1em，西文 ≈ 0.55em
    width += /[^\u0000-ÿ]/.test(ch) ? fontSize : fontSize * 0.55;
  }
  return width;
}

export class HeuristicTextMeasurer implements TextMeasurer {
  measure(text: string, style: LabelStyle): TextMeasurement {
    const measureWidth = (s: string) => estimateTextWidth(s, style.fontSize);
    const lines = wrapText(text, style, measureWidth);
    const textWidth = Math.max(...lines.map(measureWidth), 1);
    return {
      width: Math.ceil(textWidth + style.paddingX * 2),
      height: Math.ceil(lines.length * style.fontSize * style.lineHeight + style.paddingY * 2),
      lines,
    };
  }
}

export class CanvasTextMeasurer implements TextMeasurer {
  private readonly context: CanvasRenderingContext2D;

  constructor(context: CanvasRenderingContext2D) {
    this.context = context;
  }

  measure(text: string, style: LabelStyle): TextMeasurement {
    this.context.font = `${style.fontSize}px ${style.lineHeight} ${style.fontFamily}`;
    const measureWidth = (s: string) => this.context.measureText(s).width;
    const lines = wrapText(text, style, measureWidth);
    const textWidth = Math.max(...lines.map(measureWidth), 1);
    return {
      width: Math.ceil(textWidth + style.paddingX * 2),
      height: Math.ceil(lines.length * style.fontSize * style.lineHeight + style.paddingY * 2),
      lines,
    };
  }
}
