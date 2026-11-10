/** First import of the watcher entry points: reports an unusable GHOSTLINK_DEPLOYMENT before @ghostlink/service-kit loads it at import. */
import { preflightDeployment } from "@ghostlink/service-kit/startup";

preflightDeployment("watcher");
