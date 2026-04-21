import sharedTool from "../../../services/tools/memoryRetrieve.tool.js";
import { wrapSharedToolWithRemoteHooks } from "./wrapSharedToolWithRemoteHooks.js";

export default wrapSharedToolWithRemoteHooks(sharedTool);

