/** Shared design-system boundary. Ready PrimeNG controls keep their native Forms/CVA behavior. */
export { Button as UiButton } from 'primeng/button';
export { InputText as UiInput } from 'primeng/inputtext';
export { Textarea as UiTextarea } from 'primeng/textarea';
export { Select as UiSelect } from 'primeng/select';
export { Checkbox as UiCheckbox } from 'primeng/checkbox';
export { Message as UiMessage } from 'primeng/message';
export { Tag as UiTag } from 'primeng/tag';
export { ProgressSpinner as UiSpinner } from 'primeng/progressspinner';
export { provideSharedUi, serviceDeskPreset } from './theme';

export {
    CdkVirtualScrollViewport as UiVirtualScrollViewport,
    CdkVirtualForOf as UiVirtualFor,
    CdkFixedSizeVirtualScroll as UiFixedSizeVirtualScroll,
} from '@angular/cdk/scrolling';
