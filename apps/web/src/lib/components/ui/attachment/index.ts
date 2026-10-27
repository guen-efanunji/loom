import Root, {
	type AttachmentOrientation,
	type AttachmentSize,
	type AttachmentState,
	attachmentVariants,
} from "./attachment.svelte";
import Action from "./attachment-action.svelte";
import Actions from "./attachment-actions.svelte";
import Content from "./attachment-content.svelte";
import Description from "./attachment-description.svelte";
import Group from "./attachment-group.svelte";
import Media from "./attachment-media.svelte";
import Title from "./attachment-title.svelte";
import Trigger from "./attachment-trigger.svelte";

export {
	Action,
	Action as AttachmentAction,
	Actions,
	Actions as AttachmentActions,
	type AttachmentOrientation,
	type AttachmentSize,
	type AttachmentState,
	attachmentVariants,
	Content,
	Content as AttachmentContent,
	Description,
	Description as AttachmentDescription,
	Group,
	Group as AttachmentGroup,
	Media,
	Media as AttachmentMedia,
	Root,
	//
	Root as Attachment,
	Title,
	Title as AttachmentTitle,
	Trigger,
	Trigger as AttachmentTrigger,
};
