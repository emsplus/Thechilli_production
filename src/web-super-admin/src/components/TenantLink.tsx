import Link from "next/link";

export function TenantLink({ id, name }: { id: string | null | undefined; name: string }) {
  if (!id) return <span className="hq-muted">–</span>;
  return <Link href={`/businesses/${id}`} className="hq-link">{name}</Link>;
}
