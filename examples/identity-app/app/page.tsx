import { loadConfig } from "../lib/config";
import { IdentityProvider } from "../components/identity";
import { Home } from "../components/home";

export default function Page() {
  return (
    <IdentityProvider config={loadConfig()}>
      <Home />
    </IdentityProvider>
  );
}
