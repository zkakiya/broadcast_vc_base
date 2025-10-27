// シンプルなセマフォ
export function createLimiter(max = 2) {
    let active = 0;
    const q = [];
    const runNext = () => {
        if (active >= max) return;
        const job = q.shift();
        if (!job) return;
        active++;
        job().finally(() => { active--; runNext(); });
    };
    return (fn) => new Promise((res, rej) => {
        q.push(() => fn().then(res, rej));
        runNext();
    });
}
