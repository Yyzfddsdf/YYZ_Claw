import sharedTool from "../../../services/tools/memoryFindCandidates.tool.js";
import { wrapSharedToolWithRemoteHooks } from "./wrapSharedToolWithRemoteHooks.js";

export default wrapSharedToolWithRemoteHooks(sharedTool);

