/**
 * The frame implementation is owned by pi-facelift's public shared package.
 *
 * Local extensions live outside the package's node_modules ancestry, so use a
 * relative bridge to its installed source rather than copying its primitives.
 */
export {
	frameBodyLines,
	frameBottom,
	frameBottomWithLabel,
	frameResult,
	frameResultWithBottomLabel,
	frameTop,
	getFrameStatus,
	renderToolError,
	type FrameBodyOptions,
	type FrameStatus,
} from "../../npm/node_modules/@wierdbytes/pi-common/tool-frame/index.ts";
