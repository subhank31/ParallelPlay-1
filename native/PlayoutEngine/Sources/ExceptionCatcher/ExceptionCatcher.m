#import "ExceptionCatcher.h"

NSString * _Nullable PPTry(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return exception.reason ?: exception.name;
    }
}
