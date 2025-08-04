import chalk from 'chalk';

function nowTimestamp(): string {
    return new Date().toISOString().slice(0, 19);
}

function formatLevel(level: 'INFO' | 'WARN' | 'ERROR'): string {
    const map = {
        INFO:  '[INFO] ',
        WARN:  '[WARN] ',
        ERROR: '[ERROR]'
    } as const;
    return map[level];
}

function formatNetwork(net: string): string {
    return net.padEnd(12);
}

export const logger = {
    info: (network: string, msg: string) =>
        console.log(
            `${chalk.gray(nowTimestamp())} ` +
            `${chalk.blue(formatLevel('INFO'))} ` +
            `${chalk.magenta(formatNetwork(network))} ` +
            msg
        ),

    warn: (network: string, msg: string) =>
        console.log(
            `${chalk.gray(nowTimestamp())} ` +
            `${chalk.yellow(formatLevel('WARN'))} ` +
            `${chalk.magenta(formatNetwork(network))} ` +
            msg
        ),

    error: (network: string, msg: string) =>
        console.error(
            `${chalk.gray(nowTimestamp())} ` +
            `${chalk.red(formatLevel('ERROR'))} ` +
            `${chalk.magenta(formatNetwork(network))} ` +
            msg
        )
};
