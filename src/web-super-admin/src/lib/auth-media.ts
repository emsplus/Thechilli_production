import type { AuthMediaItem } from "@chilli/ui/auth";
import manifest from "../../public/auth-media/manifest.json";

/** Sign-in carousel items: edit public/auth-media/manifest.json (see docs/AUTH_MEDIA.md). Empty = brand placeholder. */
export const authMedia = manifest as AuthMediaItem[];
