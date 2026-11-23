// dsh-mac-cua-hud -- non-activating, click-through preview. The plugin owns
// this process and the anonymous stdin pipe for one task; EOF ends the HUD.
// Wire format: 4-byte big-endian length + UTF-8 JSON frame patch.
// External-source previews render supplied images only, never a desktop window.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <arpa/inet.h>
#import <errno.h>
#import <unistd.h>

static const uint32_t kMaxPayload = 16 * 1024 * 1024;

static const CGFloat kHeader = 46;
static const CGFloat kPad = 8;
static const CGFloat kWidth = 440;

@interface HudView : NSView
@property (nonatomic, strong) NSImage *image;
@property (nonatomic, copy) NSString *heading;
@property (nonatomic, copy) NSString *caption;
@property (nonatomic) BOOL hasCursor;
@property (nonatomic) CGFloat cursorX;
@property (nonatomic) CGFloat cursorY;
@property (nonatomic) CFTimeInterval pulseStart;
@end

@implementation HudView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }

- (void)drawRect:(NSRect)dirtyRect {
    NSGraphicsContext.currentContext.imageInterpolation = NSImageInterpolationHigh;
    NSRect box = NSInsetRect(self.bounds, 0.5, 0.5);
    NSBezierPath *shape = [NSBezierPath bezierPathWithRoundedRect:box xRadius:14 yRadius:14];
    [[NSColor colorWithCalibratedWhite:0.07 alpha:0.95] setFill];
    [shape fill];
    [[NSColor colorWithCalibratedWhite:1 alpha:0.14] setStroke];
    shape.lineWidth = 1;
    [shape stroke];

    CGFloat textWidth = NSWidth(self.bounds) - 46;
    NSMutableParagraphStyle *textStyle = [[NSMutableParagraphStyle alloc] init];
    textStyle.lineBreakMode = NSLineBreakByTruncatingTail;
    NSDictionary *headingAttrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:11.5 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.95 alpha:1],
        NSParagraphStyleAttributeName: textStyle
    };
    NSDictionary *captionAttrs = @{
        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular],
        NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.72 alpha:1],
        NSParagraphStyleAttributeName: textStyle
    };
    [[NSColor colorWithCalibratedRed:0.35 green:0.85 blue:0.66 alpha:1] setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(12, 11, 6, 6)] fill];
    [(self.heading ?: @"") drawInRect:NSMakeRect(24, 6, textWidth, 16) withAttributes:headingAttrs];
    [(self.caption ?: @"") drawInRect:NSMakeRect(24, 24, textWidth, 15) withAttributes:captionAttrs];

    NSImage *image = self.image;
    NSRect area = NSMakeRect(kPad, kHeader, NSWidth(self.bounds) - kPad * 2, NSHeight(self.bounds) - kHeader - kPad);
    if (NSWidth(area) < 2 || NSHeight(area) < 2) return;
    if (!image) {
        [[NSColor colorWithCalibratedWhite:1 alpha:0.055] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:area xRadius:9 yRadius:9] fill];
        NSString *placeholder = @"Waiting for preview frames…";
        NSSize labelSize = [placeholder sizeWithAttributes:captionAttrs];
        [placeholder drawAtPoint:NSMakePoint(NSMidX(area) - labelSize.width / 2,
                                            NSMidY(area) - labelSize.height / 2)
                  withAttributes:captionAttrs];
        return;
    }
    NSSize size = image.size;
    if (size.width <= 0 || size.height <= 0) return;
    CGFloat scale = MIN(NSWidth(area) / size.width, NSHeight(area) / size.height);
    NSSize drawn = NSMakeSize(size.width * scale, size.height * scale);
    NSRect imageRect = NSMakeRect(NSMidX(area) - drawn.width / 2, NSMidY(area) - drawn.height / 2,
                                  drawn.width, drawn.height);
    [image drawInRect:imageRect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver
             fraction:1 respectFlipped:YES hints:@{NSImageHintInterpolation: @(NSImageInterpolationHigh)}];

    if (!self.hasCursor) return;
    CGFloat px = NSMinX(imageRect) + NSWidth(imageRect) * MAX(0, MIN(1, self.cursorX));
    CGFloat py = NSMinY(imageRect) + NSHeight(imageRect) * MAX(0, MIN(1, self.cursorY));

    double age = CACurrentMediaTime() - self.pulseStart;
    if (age >= 0 && age < 0.7) {
        CGFloat t = (CGFloat)(age / 0.7);
        CGFloat ring = 13 + 34 * t;
        NSBezierPath *pulse = [NSBezierPath bezierPathWithOvalInRect:
            NSMakeRect(px - ring, py - ring, ring * 2, ring * 2)];
        [[NSColor colorWithCalibratedRed:1.0 green:0.32 blue:0.22 alpha:0.55 * (1 - t)] setStroke];
        pulse.lineWidth = 2.5;
        [pulse stroke];
    }
    CGFloat r = 12;
    NSBezierPath *halo = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(px - r, py - r, r * 2, r * 2)];
    [[NSColor colorWithCalibratedRed:1.0 green:0.32 blue:0.22 alpha:0.28] setFill];
    [halo fill];
    [[NSColor colorWithCalibratedWhite:1 alpha:0.92] setStroke];
    halo.lineWidth = 1.5;
    [halo stroke];
    NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(px - 3, py - 3, 6, 6)];
    [[NSColor colorWithCalibratedRed:1.0 green:0.30 blue:0.20 alpha:1] setFill];
    [dot fill];
}
@end

@interface HudPanel : NSPanel
@end

@implementation HudPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface HudController : NSObject
@property (nonatomic, strong) HudPanel *panel;
@property (nonatomic, strong) HudView *view;
@property (nonatomic, strong) NSTimer *idleTimer;
@property (nonatomic, strong) NSTimer *exitTimer;
@property (nonatomic, strong) NSTimer *hardTimer;
@property (nonatomic, strong) NSTimer *pulseTimer;
@property (nonatomic) NSUInteger frameSeq;
@property (nonatomic) NSInteger exitAfterMs;
@property (nonatomic) NSInteger maxAfterMs;
@property (nonatomic, strong) NSTimer *liveTimer;
@property (nonatomic) BOOL started;
@property (nonatomic) BOOL closing;
@property (nonatomic) BOOL liveEnabled;
@property (nonatomic) BOOL externalSource;
@property (nonatomic) double liveInterval;
@property (nonatomic) double idleMs;
@property (nonatomic) CGWindowID liveRequestedWindow;
@property (nonatomic) int livePid;
- (void)readLoop;
- (void)applyFrame:(NSDictionary *)frame;
- (void)terminatePreview;
@end

static NSData *CuaReadExact(int fd, size_t want) {
    NSMutableData *buffer = [NSMutableData dataWithLength:want];
    uint8_t *bytes = buffer.mutableBytes;
    size_t got = 0;
    while (got < want) {
        ssize_t n = read(fd, bytes + got, want - got);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return nil;
        got += (size_t)n;
    }
    return buffer;
}

@implementation HudController
- (void)start {
    self.panel = [[HudPanel alloc] initWithContentRect:NSMakeRect(0, 0, kWidth, 320)
                                             styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.panel.floatingPanel = YES;
    self.panel.level = NSStatusWindowLevel;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                    NSWindowCollectionBehaviorStationary |
                                    NSWindowCollectionBehaviorFullScreenAuxiliary |
                                    NSWindowCollectionBehaviorIgnoresCycle;
    self.panel.ignoresMouseEvents = YES;
    self.panel.opaque = NO;
    self.panel.backgroundColor = [NSColor clearColor];
    self.panel.hasShadow = YES;
    self.panel.hidesOnDeactivate = NO;
    self.panel.alphaValue = 0;
    self.view = [[HudView alloc] initWithFrame:NSMakeRect(0, 0, kWidth, 320)];
    self.panel.contentView = self.view;

    const char *exitEnv = getenv("DSH_MAC_CUA_HUD_EXIT_MS");
    self.exitAfterMs = exitEnv ? MAX(0, (NSInteger)strtol(exitEnv, NULL, 10)) : 30000;
    const char *maxEnv = getenv("DSH_MAC_CUA_HUD_MAX_MS");
    self.maxAfterMs = maxEnv ? MAX(0, (NSInteger)strtol(maxEnv, NULL, 10)) : 1800000;
    const char *liveEnv = getenv("DSH_MAC_CUA_HUD_LIVE");
    self.liveEnabled = !(liveEnv && strcmp(liveEnv, "0") == 0);
    const char *fpsEnv = getenv("DSH_MAC_CUA_HUD_FPS");
    double fps = fpsEnv ? strtod(fpsEnv, NULL) : 4.0;
    self.liveInterval = 1.0 / (isfinite(fps) ? MIN(30, MAX(1, fps)) : 4.0);

    [self resizeTo:NSMakeSize(1280, 720)];
    [NSThread detachNewThreadSelector:@selector(readLoop) toTarget:self withObject:nil];
}

- (void)readLoop {
    for (;;) {
        @autoreleasepool {
            NSData *header = CuaReadExact(STDIN_FILENO, 4);
            if (!header) break;
            uint32_t length = 0;
            [header getBytes:&length length:4];
            length = ntohl(length);
            if (length == 0 || length > kMaxPayload) break;
            NSData *payload = CuaReadExact(STDIN_FILENO, length);
            if (!payload) break;
            id object = [NSJSONSerialization JSONObjectWithData:payload options:0 error:NULL];
            if ([object isKindOfClass:[NSDictionary class]]) {
                // Do not queue an unbounded backlog of PNGs on the main thread.
                dispatch_sync(dispatch_get_main_queue(), ^{ [self applyFrame:object]; });
            }
        }
    }
    dispatch_async(dispatch_get_main_queue(), ^{ [self terminatePreview]; });
}

- (void)terminatePreview {
    if (self.closing) return;
    self.closing = YES;
    [self.idleTimer invalidate];
    [self.exitTimer invalidate];
    [self.hardTimer invalidate];
    [self.liveTimer invalidate];
    [self.pulseTimer invalidate];
    [self.panel orderOut:nil];
    self.view.image = nil;
    [NSApp terminate:nil];
}

- (void)applyFrame:(NSDictionary *)frame {
    if (self.closing) return;
    self.frameSeq += 1;
    if ([frame[@"hide"] isEqual:@YES]) {
        [self terminatePreview];
        return;
    }
    __weak HudController *weakSelf = self;
    if (!self.started) {
        self.started = YES;
        self.externalSource = [frame[@"source"] isEqual:@"external"];
        // A true task cap: it does not get extended by streaming frames.
        if (self.maxAfterMs > 0) {
            self.hardTimer = [NSTimer scheduledTimerWithTimeInterval:(double)self.maxAfterMs / 1000.0
                                                             repeats:NO block:^(__unused NSTimer *timer) {
                [weakSelf terminatePreview];
            }];
        }
    }

    id heading = frame[@"heading"];
    if ([heading isKindOfClass:[NSString class]]) self.view.heading = heading;
    id caption = frame[@"caption"];
    if ([caption isKindOfClass:[NSString class]]) self.view.caption = caption;

    id cursor = frame[@"cursor"];
    if (cursor) {
        [self.pulseTimer invalidate];
        self.view.hasCursor = NO;
        if ([cursor isKindOfClass:[NSDictionary class]]) {
            id x = cursor[@"x"], y = cursor[@"y"];
            if ([x isKindOfClass:[NSNumber class]] && [y isKindOfClass:[NSNumber class]]) {
                self.view.hasCursor = YES;
                self.view.cursorX = [x doubleValue];
                self.view.cursorY = [y doubleValue];
                self.view.pulseStart = CACurrentMediaTime();
                self.pulseTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 30.0 repeats:YES block:^(NSTimer *timer) {
                    HudController *strongSelf = weakSelf;
                    [strongSelf.view setNeedsDisplay:YES];
                    if (!strongSelf || CACurrentMediaTime() - strongSelf.view.pulseStart > 0.7) [timer invalidate];
                }];
            }
        }
    }

    if (!self.externalSource && (frame[@"windowId"] || frame[@"pid"])) {
        id windowId = frame[@"windowId"], pid = frame[@"pid"];
        if (windowId) {
            self.liveRequestedWindow = [windowId isKindOfClass:[NSNumber class]] ? [windowId unsignedIntValue] : 0;
        }
        if (pid) self.livePid = [pid isKindOfClass:[NSNumber class]] ? [pid intValue] : 0;
    }

    id base64 = frame[@"image"];
    if ([base64 isKindOfClass:[NSString class]]) {
        NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
        NSImage *image = data ? [[NSImage alloc] initWithData:data] : nil;
        if (image) {
            self.view.image = image;
            [self resizeTo:image.size];
        }
    } else if (base64 == [NSNull null]) {
        self.view.image = nil;
        [self resizeTo:NSMakeSize(1280, 720)];
    }

    if (!self.externalSource && self.liveEnabled && self.liveRequestedWindow != 0 && self.livePid > 0 &&
        (self.liveTimer || CGPreflightScreenCaptureAccess())) {
        [self startLiveTimer];
    } else {
        [self.liveTimer invalidate];
        self.liveTimer = nil;
    }
    [self.view setNeedsDisplay:YES];
    [self showPanel];

    id idle = frame[@"idleMs"];
    if ([idle isKindOfClass:[NSNumber class]]) self.idleMs = [idle doubleValue];
    [self.idleTimer invalidate];
    [self.exitTimer invalidate];
    if (self.idleMs > 0) {
        NSTimeInterval seconds = MAX(0.5, self.idleMs / 1000.0);
        self.idleTimer = [NSTimer scheduledTimerWithTimeInterval:seconds repeats:NO block:^(__unused NSTimer *timer) {
            [weakSelf hidePanel];
        }];
        if (self.exitAfterMs > 0) {
            self.exitTimer = [NSTimer scheduledTimerWithTimeInterval:seconds + (double)self.exitAfterMs / 1000.0
                                                              repeats:NO block:^(__unused NSTimer *timer) {
                [weakSelf terminatePreview];
            }];
        }
    }
}

- (void)startLiveTimer {
    if (self.liveTimer) return;
    __weak HudController *weakLive = self;
    NSTimer *timer = [NSTimer timerWithTimeInterval:self.liveInterval repeats:YES block:^(NSTimer *fired) {
        HudController *strongLive = weakLive;
        if (!strongLive) { [fired invalidate]; return; }
        [strongLive captureTick];
    }];
    self.liveTimer = timer;
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
}

- (void)captureTick {
    if (self.closing || self.externalSource || !self.panel.isVisible ||
        self.liveRequestedWindow == 0 || self.livePid <= 0) return;
    // Verify the requested window still belongs to the exact target process.
    // Do not guess another window in the same app if an AX id is not a CG id;
    // the plugin's scoped native screenshot remains visible in that case.
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
                                                                    self.liveRequestedWindow));
    NSDictionary *info = windows.firstObject;
    if ([info[(id)kCGWindowNumber] unsignedIntValue] != self.liveRequestedWindow ||
        [info[(id)kCGWindowOwnerPID] intValue] != self.livePid) return;
    CGImageRef image = CGWindowListCreateImage(CGRectNull, kCGWindowListOptionIncludingWindow,
                                               self.liveRequestedWindow, kCGWindowImageBoundsIgnoreFraming);
    if (!image) return;
    NSSize size = NSMakeSize((CGFloat)CGImageGetWidth(image), (CGFloat)CGImageGetHeight(image));
    NSImage *photo = [[NSImage alloc] initWithCGImage:image size:size];
    CGImageRelease(image);
    if (!photo) return;
    self.view.image = photo;
    [self resizeTo:size];
    [self.view setNeedsDisplay:YES];
}

- (void)resizeTo:(NSSize)imageSize {
    CGFloat available = kWidth - kPad * 2;
    CGFloat height = available * (imageSize.height / MAX(imageSize.width, 1));
    height = MIN(MAX(height, 120), 560);
    NSSize size = NSMakeSize(kWidth, kHeader + height + kPad);
    NSScreen *screen = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
    NSRect visible = screen ? screen.visibleFrame : NSMakeRect(0, 0, 1440, 900);
    NSRect rect = NSMakeRect(NSMaxX(visible) - size.width - 16,
                             NSMaxY(visible) - size.height - 16,
                             size.width, size.height);
    if (NSEqualRects(self.panel.frame, rect)) return;
    [self.panel setFrame:rect display:YES];
    self.view.frame = NSMakeRect(0, 0, size.width, size.height);
}

- (void)showPanel {
    if (self.panel.alphaValue < 0.99) [self fadeTo:1];
    if (!self.panel.isVisible) [self.panel orderFrontRegardless];
}

- (void)fadeTo:(CGFloat)alpha {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = alpha > 0 ? 0.12 : 0.3;
        self.panel.animator.alphaValue = alpha;
    } completionHandler:nil];
}

// Fade out, then take the window off screen entirely. If a new frame lands
// during the fade the window keeps its place -- the agent resumed working.
- (void)hidePanel {
    if (!self.panel.isVisible) return;
    [self.liveTimer invalidate];
    self.liveTimer = nil;
    NSUInteger seq = self.frameSeq;
    __weak HudController *weakSelf = self;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.2;
        weakSelf.panel.animator.alphaValue = 0;
    } completionHandler:^{
        HudController *strongSelf = weakSelf;
        if (!strongSelf || strongSelf.frameSeq != seq) return;
        [strongSelf.panel orderOut:nil];
    }];
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        HudController *controller = [[HudController alloc] init];
        [controller start];
        [app run];
    }
    return 0;
}
