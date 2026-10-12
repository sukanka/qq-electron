/* Reproduce a native addon's fatal child-atfork callback without touching QQ. */
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>

static int log_fd = -1;

static void child_atfork(void) {
    if (log_fd >= 0)
        (void)write(log_fd, "forked\n", 7);
    _exit(86);
}

__attribute__((constructor)) static void install_fork_guard(void) {
    const char *path = getenv("QQ_PORTAL_TEST_FORK_GUARD_LOG");
    if (!path)
        return;
    log_fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (log_fd < 0 || pthread_atfork(NULL, NULL, child_atfork) != 0)
        _exit(85);
    (void)write(log_fd, "loaded\n", 7);
}
