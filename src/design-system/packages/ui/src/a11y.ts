import axe from 'axe-core';

/** Runs axe on a container and returns violation summaries (empty = pass). */
export async function axeViolations(container: Element): Promise<string[]> {
  const res = await axe.run(container, {
    // jsdom has no layout, so colour contrast is verified in @chilli/tokens tests instead.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return res.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}
