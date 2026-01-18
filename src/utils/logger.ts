import chalk from 'chalk';
import { config } from 'dotenv';

config();

const LOG_FORMAT = (process.env.LOG_FORMAT || 'pretty').toLowerCase();

function nowTimestamp(): string {
    return new Date().toISOString().slice(0, 19);
}

function formatLevel(level: 'INFO' | 'WARN' | 'ERROR'): string {
    return level;
}

function emitLog(level: 'INFO' | 'WARN' | 'ERROR', network: string, msg: string): void {
    const ts = nowTimestamp();
    let reqId: string | undefined;
    let restMsg = msg;
    const reqMatch = msg.match(/^([^[]*?)\[([0-9a-fA-F-]{36})\](.*)$/);
    if (reqMatch) {
        reqId = reqMatch[2];
        restMsg = `${reqMatch[1]}${reqMatch[3]}`;
    }

    if (LOG_FORMAT === 'json') {
        const payload = reqId ? { ts, level, net: network, req: reqId, msg: restMsg } : { ts, level, net: network, msg: restMsg };
        const line = JSON.stringify(payload);
        if (level === 'ERROR') {
            console.error(line);
        } else {
            console.log(line);
        }
        return;
    }

    const reqToken = reqId ? ` [${reqId}]` : '';

    const color =
        level === 'INFO' ? chalk.blue :
        level === 'WARN' ? chalk.yellow :
        chalk.red;

    const out = `${chalk.gray(ts)}${reqToken} ${color(formatLevel(level))} ${chalk.magenta(network)} ${restMsg}`;
    if (level === 'ERROR') {
        console.error(out);
    } else {
        console.log(out);
    }
}

export const logger = {
    info: (network: string, msg: string) => emitLog('INFO', network, msg),
    warn: (network: string, msg: string) => emitLog('WARN', network, msg),
    error: (network: string, msg: string) => emitLog('ERROR', network, msg)
};
