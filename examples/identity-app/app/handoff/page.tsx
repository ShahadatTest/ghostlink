import { loadConfig } from "../../lib/config";
import { IdentityProvider } from "../../components/identity";
import { Handoff } from "../../components/handoff";

/** Opened by a site's sign-in button in a popup (`requestLogin` in @ghostlink/sdk). */
export default function HandoffPage() {
  return (
    <IdentityProvider config={loadConfig()}>
      <Handoff />
    </IdentityProvider>
  );
}
