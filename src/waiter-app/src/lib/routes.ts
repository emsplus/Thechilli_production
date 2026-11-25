import { useParams, useSearchParams } from "next/navigation";

/** Native (static export) builds cannot enumerate order ids, so they link to /orders/_/?id=<id>. */
const NATIVE = process.env.NEXT_PUBLIC_NATIVE === "1";
export const orderHref = (id: string) => (NATIVE ? `/orders/_/?id=${encodeURIComponent(id)}` : `/orders/${id}`);

export function useOrderId(): string {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams().get("id");
  return id === "_" && q ? q : id;
}

/** True on the outlet screen with or without the trailing slash (static export uses "/outlet/", e.g. in iOS WKWebView). */
export const isOutletPath = (pathname: string): boolean => pathname.replace(/\/+$/, "") === "/outlet";
