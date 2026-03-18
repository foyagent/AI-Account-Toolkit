import { randomBytes } from 'crypto';

/**
 * 生成 Datadog Trace 头（模拟浏览器行为）
 */
export function generateDatadogTrace(): Record<string, string> {
  const traceId = randomBytes(8).toString('hex');
  const parentId = randomBytes(8).toString('hex');

  const traceHex = traceId.padStart(16, '0').slice(-16);
  const parentHex = parentId.padStart(16, '0').slice(-16);

  return {
    traceparent: `00-0000000000000000${traceHex}-${parentHex}-01`,
    tracestate: 'dd=s:1;o:rum',
    'x-datadog-origin': 'rum',
    'x-datadog-parent-id': parentId,
    'x-datadog-sampling-priority': '1',
    'x-datadog-trace-id': traceId,
  };
}
