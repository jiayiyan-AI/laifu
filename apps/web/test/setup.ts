import '@testing-library/jest-dom';

// jsdom 不提供 EventSource (Conversation 组件 mount 时建 SSE 连接)。
// 测试里只关心 fetch 行为, 给个最小桩避免 ReferenceError 就够了。
if (typeof globalThis.EventSource === 'undefined') {
  class EventSourceStub {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  }
  (globalThis as { EventSource: unknown }).EventSource = EventSourceStub;
}
