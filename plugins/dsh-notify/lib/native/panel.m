// dsh-notify — macOS native approval panel.
//
// A tiny, single-file Objective-C (ARC) helper spawned by `runner.js`. It shows a
// non-activating NSPanel in the top-right corner of the screen with two buttons
// (allow / deny) plus an unobtrusive close button, prints exactly one JSON line
// on stdout (`{"choice":"allow"}` and friends) and exits.
//
// Build (no swiftc, no third-party deps):
//   clang -fobjc-arc -O2 -framework Cocoa -o panel panel.m
//
// Diagnostics (window frame, capture rect) and stray logs go to stderr only.

#import <Cocoa/Cocoa.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>

#pragma mark - Constants

static const CGFloat kPanelWidth = 400.0;
static const CGFloat kPadding = 16.0;
static const CGFloat kCornerRadius = 12.0;
static const CGFloat kButtonHeight = 30.0;
static const CGFloat kCloseSize = 22.0;
static const CGFloat kCloseInset = 12.0;
static const NSUInteger kBodyMaxLines = 6;
static const NSUInteger kTitleMaxLines = 2;
static const NSUInteger kSubtitleMaxLines = 2;

static BOOL gSettled = NO;

#pragma mark - Output

static void DNEmit(NSString *choice) {
    if (gSettled) {
        return;
    }
    gSettled = YES;
    NSString *line = [NSString stringWithFormat:@"{\"choice\":\"%@\"}", choice];
    const char *utf8 = line.UTF8String;
    fwrite(utf8, 1, strlen(utf8), stdout);
    fputc('\n', stdout);
    fflush(stdout);
    fprintf(stderr, "[panel] choice=%s\n", choice.UTF8String);
    fflush(stderr);
    exit(0);
}

static void DNHandleSignal(int signalNumber) {
    // SIGTERM/SIGINT: die immediately, without output. The runner maps an abort
    // to `dismiss`; any other unexpected kill is treated as a failure there.
    (void)signalNumber;
    _exit(1);
}

#pragma mark - Parent watchdog

/// Exit when the spawning Host process disappears.
///
/// Without this, closing or restarting the application while a request is
/// pending would leave the panel on screen until its own timeout. `getppid()`
/// changes to 1 (launchd) once the Host Node process is gone.
static void DNWatchParent(pid_t parent) {
    NSTimer *timer = [NSTimer timerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *watchdog) {
        (void)watchdog;
        if (getppid() != parent) {
            fprintf(stderr, "[panel] host process exited; closing\n");
            fflush(stderr);
            _exit(1);
        }
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
}

#pragma mark - Colors

static NSColor *DNSurfaceColor(void) {
    return [NSColor colorWithName:nil
                dynamicProvider:^NSColor *(NSAppearance *appearance) {
                    NSAppearanceName best = [appearance bestMatchFromAppearancesWithNames:@[
                        NSAppearanceNameAqua, NSAppearanceNameDarkAqua
                    ]];
                    if ([best isEqualToString:NSAppearanceNameDarkAqua]) {
                        return [NSColor colorWithWhite:1.0 alpha:0.16];
                    }
                    return [NSColor colorWithWhite:0.0 alpha:0.07];
                }];
}

#pragma mark - Geometry helpers

static CGFloat DNLineHeight(NSFont *font) {
    return ceil(font.ascender - font.descender + font.leading);
}

/// Unclamped wrapped height of `text` at `width`.
static CGFloat DNMeasureHeight(NSString *text, NSFont *font, CGFloat width) {
    if (text.length == 0 || width <= 0.0) {
        return 0.0;
    }
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.lineBreakMode = NSLineBreakByWordWrapping;
    NSDictionary *attributes = @{
        NSFontAttributeName: font,
        NSParagraphStyleAttributeName: paragraph,
    };
    NSRect rect = [text boundingRectWithSize:NSMakeSize(width, CGFLOAT_MAX)
                                     options:(NSStringDrawingUsesLineFragmentOrigin |
                                              NSStringDrawingUsesFontLeading)
                                  attributes:attributes];
    return ceil(NSHeight(rect));
}

/// Truncate `text` with an explicit ellipsis so it fits within `maxLines`.
///
/// NSTextField's own multi-line "truncating tail" clips silently (no ellipsis),
/// so the limitation is applied here, before layout, instead.
static NSString *DNFitText(NSString *text, NSFont *font, CGFloat width, NSUInteger maxLines) {
    if (text.length == 0 || width <= 0.0 || maxLines == 0) {
        return text ?: @"";
    }
    CGFloat maxHeight = DNLineHeight(font) * (CGFloat)maxLines + 1.0;
    if (DNMeasureHeight(text, font, width) <= maxHeight) {
        return text;
    }

    NSString *ellipsis = @"…";
    NSInteger low = 0;
    NSInteger high = (NSInteger)text.length;
    while (low < high) {
        NSInteger mid = (low + high + 1) / 2;
        if (mid > 0 && mid < (NSInteger)text.length) {
            unichar previous = [text characterAtIndex:(NSUInteger)mid - 1];
            if (previous >= 0xD800 && previous <= 0xDBFF) {
                mid -= 1; // Never split a surrogate pair.
            }
        }
        if (mid <= low) {
            break;
        }
        NSString *kept = [text substringToIndex:(NSUInteger)mid];
        kept = [kept stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        NSString *candidate = [kept stringByAppendingString:ellipsis];
        if (DNMeasureHeight(candidate, font, width) <= maxHeight) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    NSString *prefix = low > 0 ? [text substringToIndex:(NSUInteger)low] : @"";
    prefix = [prefix stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return [prefix stringByAppendingString:ellipsis];
}

static CGFloat DNTextWidth(NSString *text, NSFont *font) {
    if (text.length == 0) {
        return 0.0;
    }
    NSDictionary *attributes = @{NSFontAttributeName: font};
    return ceil([text sizeWithAttributes:attributes].width);
}

#pragma mark - Views

@interface DNPillButton : NSButton

/// 0 = primary (accent), 1 = secondary (subtle surface), 2 = dismiss (glyph).
@property(nonatomic, assign) NSInteger kind;
@property(nonatomic, strong) NSColor *accentColor;

@end

@implementation DNPillButton

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    // The panel never becomes key; without this the first click would only
    // "activate" the window and never reach the button.
    (void)event;
    return YES;
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSRect bounds = self.bounds;

    if (self.kind == 2) {
        if (self.isHighlighted) {
            NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(bounds, 1.0, 1.0)
                                                                 xRadius:5.0
                                                                 yRadius:5.0];
            [[NSColor colorWithWhite:0.5 alpha:0.18] setFill];
            [path fill];
        }
    } else {
        NSColor *fill = (self.kind == 0) ? (self.accentColor ?: NSColor.controlAccentColor)
                                          : DNSurfaceColor();
        if (self.isHighlighted) {
            fill = [fill blendedColorWithFraction:0.18 ofColor:NSColor.blackColor];
        }
        NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(bounds, 0.5, 0.5)
                                                             xRadius:8.0
                                                             yRadius:8.0];
        [fill setFill];
        [path fill];
    }

    NSString *title = self.title ?: @"";
    NSColor *textColor = (self.kind == 0) ? NSColor.whiteColor
                                          : (self.kind == 2 ? NSColor.tertiaryLabelColor
                                                            : NSColor.labelColor);
    NSFont *font = self.font ?: [NSFont systemFontOfSize:13.0 weight:NSFontWeightMedium];

    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.alignment = NSTextAlignmentCenter;
    paragraph.lineBreakMode = NSLineBreakByTruncatingTail;
    NSDictionary *attributes = @{
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: textColor,
        NSParagraphStyleAttributeName: paragraph,
    };
    NSSize textSize = [title sizeWithAttributes:attributes];
    NSRect textRect = NSMakeRect(0.0,
                                 NSMidY(bounds) - textSize.height / 2.0,
                                 NSWidth(bounds),
                                 textSize.height);
    [title drawInRect:textRect withAttributes:attributes];
}

@end

/// Border overlay: draws the hairline outline, but must never swallow clicks.
@interface DNBorderView : NSView
@end

@implementation DNBorderView

- (NSView *)hitTest:(NSPoint)point {
    (void)point;
    return nil;
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 0.5, 0.5)
                                                         xRadius:kCornerRadius
                                                         yRadius:kCornerRadius];
    path.lineWidth = 1.0;
    [[NSColor.separatorColor colorWithAlphaComponent:0.55] setStroke];
    [path stroke];
}

@end

@interface DNController : NSObject
- (void)actAllow:(id)sender;
- (void)actDeny:(id)sender;
- (void)actDismiss:(id)sender;
@end

@implementation DNController

- (void)actAllow:(id)sender {
    (void)sender;
    DNEmit(@"allow");
}

- (void)actDeny:(id)sender {
    (void)sender;
    DNEmit(@"deny");
}

- (void)actDismiss:(id)sender {
    (void)sender;
    DNEmit(@"dismiss");
}

@end

#pragma mark - Labels

static NSTextField *DNMakeLabel(NSString *text,
                                NSFont *font,
                                NSColor *color,
                                CGFloat width,
                                BOOL singleLine) {
    NSTextField *label = [[NSTextField alloc] initWithFrame:NSMakeRect(0.0, 0.0, width, 0.0)];
    label.stringValue = text ?: @"";
    label.font = font;
    label.textColor = color;
    label.alignment = NSTextAlignmentLeft;
    label.editable = NO;
    label.selectable = NO;
    label.bordered = NO;
    label.bezeled = NO;
    label.drawsBackground = NO;
    label.focusRingType = NSFocusRingTypeNone;
    label.maximumNumberOfLines = singleLine ? 1 : 0;
    label.lineBreakMode = singleLine ? NSLineBreakByTruncatingTail : NSLineBreakByWordWrapping;
    label.preferredMaxLayoutWidth = width;
    label.cell.wraps = !singleLine;
    label.cell.usesSingleLineMode = singleLine;
    return label;
}

#pragma mark - Arguments

static NSString *DNString(NSDictionary<NSString *, NSString *> *options, NSString *key, NSString *fallback) {
    NSString *value = options[key];
    if (value == nil || value.length == 0) {
        return fallback;
    }
    return value;
}

#pragma mark - Main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        (void)argc;
        (void)argv;
        pid_t originalParent = getppid();

        NSMutableDictionary<NSString *, NSString *> *options = [NSMutableDictionary dictionary];
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        for (NSUInteger index = 1; index < arguments.count; index++) {
            NSString *argument = arguments[index];
            if (![argument hasPrefix:@"--"]) {
                continue;
            }
            NSString *key = argument;
            NSString *value = nil;
            NSRange equals = [argument rangeOfString:@"="];
            if (equals.location != NSNotFound) {
                key = [argument substringToIndex:equals.location];
                value = [argument substringFromIndex:equals.location + 1];
            } else if (index + 1 < arguments.count) {
                value = arguments[++index];
            }
            if (key.length > 0 && value != nil) {
                options[key] = value;
            }
        }

        NSString *locale = [DNString(options, @"--locale", @"zh") lowercaseString];
        BOOL english = [locale isEqualToString:@"en"];

        NSString *title = DNString(options, @"--title",
                                   english ? @"Approval requested" : @"请求审批");
        NSString *subtitle = DNString(options, @"--subtitle", @"");
        NSString *body = DNString(options, @"--body",
                                  english ? @"This action needs your confirmation." : @"此操作需要你的确认。");
        NSString *meta = DNString(options, @"--meta",
                                  english ? @"DeepSeek Harness · Waiting for approval"
                                          : @"DeepSeek Harness · 等待审批");
        NSString *allowLabel = DNString(options, @"--allow",
                                        english ? @"Allow once" : @"允许一次");
        NSString *denyLabel = DNString(options, @"--deny",
                                       english ? @"Deny" : @"拒绝");
        NSString *dismissLabel = DNString(options, @"--dismiss",
                                          english ? @"Close" : @"关闭");

        long long timeoutMs = DNString(options, @"--timeout-ms", @"").longLongValue;
        if (timeoutMs <= 0) {
            timeoutMs = 180000;
        }
        if (timeoutMs < 1000) {
            timeoutMs = 1000;
        }
        if (timeoutMs > 3600000) {
            timeoutMs = 3600000;
        }

        NSFont *metaFont = [NSFont systemFontOfSize:10.0 weight:NSFontWeightSemibold];
        NSFont *titleFont = [NSFont systemFontOfSize:15.0 weight:NSFontWeightSemibold];
        NSFont *subtitleFont = [NSFont systemFontOfSize:12.0 weight:NSFontWeightRegular];
        NSFont *bodyFont = [NSFont systemFontOfSize:13.0 weight:NSFontWeightRegular];
        NSFont *buttonFont = [NSFont systemFontOfSize:13.0 weight:NSFontWeightMedium];

        CGFloat innerWidth = kPanelWidth - kPadding * 2.0;
        CGFloat titleWidth = innerWidth - kCloseSize - 6.0;

        // NSTextField's cell wraps slightly inside its frame (~3 pt), so wrap and
        // truncate against a narrower "measure" width than the label frame. Without
        // this the explicit ellipsis could spill onto a hidden 7th line.
        const CGFloat kTextSafety = 8.0;
        CGFloat metaMeasureWidth = MAX(40.0, titleWidth - kTextSafety);
        CGFloat titleMeasureWidth = MAX(40.0, titleWidth - kTextSafety);
        CGFloat contentMeasureWidth = MAX(40.0, innerWidth - kTextSafety);

        // Truncate with an explicit ellipsis before layout: NSTextField clips
        // multi-line overflow silently, which would cut the last line mid-glyph.
        NSString *metaText = DNFitText(meta, metaFont, metaMeasureWidth, 1);
        NSString *titleText = DNFitText(title, titleFont, titleMeasureWidth, kTitleMaxLines);
        NSString *subtitleText = subtitle.length > 0
                                     ? DNFitText(subtitle, subtitleFont, contentMeasureWidth, kSubtitleMaxLines)
                                     : @"";
        NSString *bodyText = body.length > 0
                                 ? DNFitText(body, bodyFont, contentMeasureWidth, kBodyMaxLines)
                                 : @"";

        CGFloat metaHeight = metaText.length > 0
                                 ? DNMeasureHeight(metaText, metaFont, metaMeasureWidth) + 1.0
                                 : 0.0;
        CGFloat titleHeight = titleText.length > 0
                                  ? DNMeasureHeight(titleText, titleFont, titleMeasureWidth) + 1.0
                                  : 0.0;
        CGFloat subtitleHeight = subtitleText.length > 0
                                     ? DNMeasureHeight(subtitleText, subtitleFont, contentMeasureWidth) + 1.0
                                     : 0.0;
        CGFloat bodyHeight = bodyText.length > 0
                                 ? DNMeasureHeight(bodyText, bodyFont, contentMeasureWidth) + 1.0
                                 : 0.0;

        CGFloat allowWidth = MAX(72.0, DNTextWidth(allowLabel, buttonFont) + 32.0);
        CGFloat denyWidth = MAX(68.0, DNTextWidth(denyLabel, buttonFont) + 32.0);

        CGFloat panelHeight = kPadding;
        if (metaHeight > 0.0) {
            panelHeight += metaHeight + 6.0;
        }
        panelHeight += titleHeight;
        if (subtitleHeight > 0.0) {
            panelHeight += 4.0 + subtitleHeight;
        }
        if (bodyHeight > 0.0) {
            panelHeight += (subtitleHeight > 0.0 ? 8.0 : 10.0) + bodyHeight;
        }
        panelHeight += 14.0 + kButtonHeight + kPadding;
        panelHeight = ceil(panelHeight);

        NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
        NSRect visibleFrame = screen.visibleFrame;
        CGFloat originX = NSMaxX(visibleFrame) - 16.0 - kPanelWidth;
        CGFloat originY = NSMaxY(visibleFrame) - 16.0 - panelHeight;

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];

        NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(originX, originY, kPanelWidth, panelHeight)
                                                    styleMask:(NSWindowStyleMaskBorderless |
                                                               NSWindowStyleMaskNonactivatingPanel)
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO];
        panel.opaque = NO;
        panel.backgroundColor = NSColor.clearColor;
        panel.hasShadow = YES;
        panel.level = NSStatusWindowLevel;
        panel.collectionBehavior = (NSWindowCollectionBehaviorCanJoinAllSpaces |
                                    NSWindowCollectionBehaviorFullScreenAuxiliary);
        panel.hidesOnDeactivate = NO;
        panel.becomesKeyOnlyIfNeeded = YES;
        panel.movableByWindowBackground = NO;
        panel.releasedWhenClosed = NO;
        panel.animationBehavior = NSWindowAnimationBehaviorNone;
        panel.floatingPanel = YES;
        panel.title = title;

        NSView *container = [[NSView alloc] initWithFrame:NSMakeRect(0.0, 0.0, kPanelWidth, panelHeight)];
        container.wantsLayer = YES;
        container.layer.cornerRadius = kCornerRadius;
        container.layer.masksToBounds = YES;
        container.autoresizingMask = (NSViewWidthSizable | NSViewHeightSizable);
        panel.contentView = container;

        [container setAccessibilityRole:NSAccessibilityGroupRole];
        [container setAccessibilityLabel:title];
        [panel setAccessibilityRole:NSAccessibilityGroupRole];
        [panel setAccessibilityLabel:title];

        NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:container.bounds];
        effect.autoresizingMask = (NSViewWidthSizable | NSViewHeightSizable);
        effect.material = NSVisualEffectMaterialPopover;
        effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        effect.state = NSVisualEffectStateActive;
        effect.wantsLayer = YES;
        effect.layer.cornerRadius = kCornerRadius;
        effect.layer.masksToBounds = YES;
        [container addSubview:effect];

        DNController *controller = [[DNController alloc] init];

        CGFloat cursorY = panelHeight - kPadding;

        if (metaHeight > 0.0) {
            NSTextField *metaLabel = DNMakeLabel(metaText, metaFont, NSColor.secondaryLabelColor,
                                                 titleWidth, YES);
            metaLabel.frame = NSMakeRect(kPadding, cursorY - metaHeight, titleWidth, metaHeight);
            [container addSubview:metaLabel];
            cursorY -= metaHeight + 6.0;
        }

        if (titleHeight > 0.0) {
            NSTextField *titleLabel = DNMakeLabel(titleText, titleFont, NSColor.labelColor,
                                                  titleWidth, NO);
            titleLabel.frame = NSMakeRect(kPadding, cursorY - titleHeight, titleWidth, titleHeight);
            [container addSubview:titleLabel];
            cursorY -= titleHeight;
        }

        if (subtitleHeight > 0.0) {
            cursorY -= 4.0;
            NSTextField *subtitleLabel = DNMakeLabel(subtitleText, subtitleFont,
                                                     NSColor.secondaryLabelColor,
                                                     innerWidth, NO);
            subtitleLabel.frame = NSMakeRect(kPadding, cursorY - subtitleHeight,
                                             innerWidth, subtitleHeight);
            [container addSubview:subtitleLabel];
            cursorY -= subtitleHeight;
        }

        if (bodyHeight > 0.0) {
            cursorY -= (subtitleHeight > 0.0 ? 8.0 : 10.0);
            NSTextField *bodyLabel = DNMakeLabel(bodyText, bodyFont, NSColor.labelColor,
                                                 innerWidth, NO);
            bodyLabel.frame = NSMakeRect(kPadding, cursorY - bodyHeight, innerWidth, bodyHeight);
            [container addSubview:bodyLabel];
            cursorY -= bodyHeight;
        }

        CGFloat buttonY = kPadding;
        CGFloat allowX = kPanelWidth - kPadding - allowWidth;
        CGFloat denyX = allowX - 8.0 - denyWidth;

        DNPillButton *allowButton = [[DNPillButton alloc]
            initWithFrame:NSMakeRect(allowX, buttonY, allowWidth, kButtonHeight)];
        allowButton.kind = 0;
        allowButton.accentColor = NSColor.controlAccentColor;
        allowButton.font = buttonFont;
        allowButton.title = allowLabel;
        allowButton.bordered = NO;
        allowButton.bezelStyle = NSBezelStyleRegularSquare;
        allowButton.focusRingType = NSFocusRingTypeNone;
        allowButton.target = controller;
        allowButton.action = @selector(actAllow:);
        [allowButton setAccessibilityRole:NSAccessibilityButtonRole];
        [allowButton setAccessibilityLabel:allowLabel];
        [container addSubview:allowButton];

        DNPillButton *denyButton = [[DNPillButton alloc]
            initWithFrame:NSMakeRect(denyX, buttonY, denyWidth, kButtonHeight)];
        denyButton.kind = 1;
        denyButton.font = buttonFont;
        denyButton.title = denyLabel;
        denyButton.bordered = NO;
        denyButton.bezelStyle = NSBezelStyleRegularSquare;
        denyButton.focusRingType = NSFocusRingTypeNone;
        denyButton.target = controller;
        denyButton.action = @selector(actDeny:);
        [denyButton setAccessibilityRole:NSAccessibilityButtonRole];
        [denyButton setAccessibilityLabel:denyLabel];
        [container addSubview:denyButton];

        DNPillButton *closeButton = [[DNPillButton alloc]
            initWithFrame:NSMakeRect(kPanelWidth - kCloseInset - kCloseSize,
                                     panelHeight - kCloseInset - kCloseSize,
                                     kCloseSize, kCloseSize)];
        closeButton.kind = 2;
        closeButton.font = [NSFont systemFontOfSize:11.0 weight:NSFontWeightMedium];
        closeButton.title = @"✕";
        closeButton.bordered = NO;
        closeButton.bezelStyle = NSBezelStyleRegularSquare;
        closeButton.focusRingType = NSFocusRingTypeNone;
        closeButton.target = controller;
        closeButton.action = @selector(actDismiss:);
        [closeButton setAccessibilityRole:NSAccessibilityButtonRole];
        [closeButton setAccessibilityLabel:dismissLabel];
        [container addSubview:closeButton];

        DNBorderView *border = [[DNBorderView alloc] initWithFrame:container.bounds];
        border.autoresizingMask = (NSViewWidthSizable | NSViewHeightSizable);
        [container addSubview:border];

        [panel orderFrontRegardless];
        DNWatchParent(originalParent);

        NSRect windowFrame = panel.frame;
        CGFloat captureTop = NSMaxY(screen.frame) - NSMaxY(windowFrame);
        fprintf(stderr,
                "[panel] shown frame=%.1f,%.1f %.1fx%.1f screen=%.1f,%.1f %.1fx%.1f\n",
                windowFrame.origin.x, windowFrame.origin.y,
                windowFrame.size.width, windowFrame.size.height,
                screen.frame.origin.x, screen.frame.origin.y,
                screen.frame.size.width, screen.frame.size.height);
        fprintf(stderr, "[panel] capture x=%.0f y=%.0f w=%.0f h=%.0f\n",
                NSMinX(windowFrame), captureTop,
                NSWidth(windowFrame), NSHeight(windowFrame));
        fflush(stderr);

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutMs * NSEC_PER_MSEC)),
                       dispatch_get_main_queue(), ^{
                           DNEmit(@"timeout");
                       });

        signal(SIGTERM, DNHandleSignal);
        signal(SIGINT, DNHandleSignal);

        [NSApp run];

        if (!gSettled) {
            DNEmit(@"dismiss");
        }
    }
    return 0;
}
