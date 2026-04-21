import sharedTool from "../../../services/tools/memoryBrowse.tool.js";
import { wrapSharedToolWithRemoteHooks } from "./wrapSharedToolWithRemoteHooks.js";

export default wrapSharedToolWithRemoteHooks(sharedTool);

