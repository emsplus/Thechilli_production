import { redirect } from "next/navigation";

/** Sign-up only app: the home page lives on the separate marketing website; here "/" goes straight to the sign-up. */
export default function Home(): never {
  redirect("/signup");
}
