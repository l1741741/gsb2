/** 测试用的严格 DOM 查询：找不到元素直接失败，而不是把 null 传下去。 */
export function must(window: { document: Document }, selector: string): HTMLElement {
  const element = window.document.querySelector(selector);
  if (!element) throw new Error(`测试页面缺少元素 ${selector}`);
  return element as HTMLElement;
}

export function mustInput(window: { document: Document }, selector: string): HTMLInputElement {
  return must(window, selector) as HTMLInputElement;
}

export function mustSelect(window: { document: Document }, selector: string): HTMLSelectElement {
  return must(window, selector) as HTMLSelectElement;
}
