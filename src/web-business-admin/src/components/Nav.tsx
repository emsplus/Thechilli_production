/**
 * Compatibility shim: navigation now lives in the app shell (components/shell).
 * Pages that still render <Nav current="..."/> get nothing; remove the call when migrating a page.
 * @deprecated
 */
export function Nav(_props: { current?: string }) {
  void _props;
  return null;
}
