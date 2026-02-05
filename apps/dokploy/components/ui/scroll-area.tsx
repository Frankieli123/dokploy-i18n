import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as React from "react";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
		viewPortClassName?: string;
		viewportRef?: React.Ref<HTMLDivElement>;
		onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
	}
>(
	(
		{
			className,
			children,
			viewPortClassName,
			viewportRef,
			onViewportScroll,
			...props
		},
		ref,
	) => {
		const viewportRefLocal = React.useRef<HTMLDivElement | null>(null);
		const mergedViewportRef = React.useCallback(
			(node: HTMLDivElement | null) => {
				viewportRefLocal.current = node;
				if (!viewportRef) return;
				if (typeof viewportRef === "function") {
					viewportRef(node);
					return;
				}
				(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current =
					node;
			},
			[viewportRef],
		);

		const handleScrollbarWheel = React.useCallback(
			(event: React.WheelEvent<HTMLDivElement>) => {
				const viewport = viewportRefLocal.current;
				if (!viewport) return;
				if (event.deltaY) viewport.scrollTop += event.deltaY;
				if (event.deltaX) viewport.scrollLeft += event.deltaX;
			},
			[],
		);

		return (
			<ScrollAreaPrimitive.Root
				ref={ref}
				className={cn("relative overflow-hidden flex flex-col", className)}
				{...props}
			>
				<ScrollAreaPrimitive.Viewport
					ref={mergedViewportRef}
					onScroll={onViewportScroll}
					// [&>div]:!block
					className={cn(
						"flex-1 min-h-0 w-full rounded-[inherit]",
						viewPortClassName,
					)}
				>
					{children}
				</ScrollAreaPrimitive.Viewport>
				<ScrollBar onWheel={handleScrollbarWheel} />
				<ScrollAreaPrimitive.Corner />
			</ScrollAreaPrimitive.Root>
		);
	},
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
	<ScrollAreaPrimitive.ScrollAreaScrollbar
		ref={ref}
		orientation={orientation}
		className={cn(
			"flex touch-none select-none transition-colors",
			orientation === "vertical" &&
				"h-full w-2.5 border-l border-l-transparent p-[1px]",
			orientation === "horizontal" &&
				"h-2.5 flex-col border-t border-t-transparent p-[1px]",
			className,
		)}
		{...props}
	>
		<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
	</ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
