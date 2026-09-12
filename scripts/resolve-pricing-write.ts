/** Read-only by default. --apply records an operator's explicit attestation;
 * it cannot prove an old upstream request ended and never restarts services. */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { prisma } from '@/lib/db';
import { resolvePricingWriteManually } from '@/lib/admin/pricing-publish-journal';

async function main() {
    const { values } = parseArgs({
        options: {
            'write-id': { type: 'string' },
            apply: { type: 'boolean', default: false },
            operator: { type: 'string' },
            evidence: { type: 'string' },
            'confirm-upstream-requests-ended': { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    if (!values.apply) {
        const writes = await prisma.pricingPublishWrite.findMany({
            where: { status: 'in_flight', ...(values['write-id'] ? { id: values['write-id'] } : {}) },
            orderBy: { created_at: 'asc' },
            select: { id: true, job_id: true, key: true, request_hash: true, created_at: true },
        });
        console.log(JSON.stringify({ dry_run: true, uncertain_writes: writes }, null, 2));
        return;
    }
    if (!values['write-id'] || !values.operator || !values.evidence || !values['confirm-upstream-requests-ended']) {
        throw new Error(
            'Applying requires a write ID, operator, evidence and explicit upstream-request termination confirmation.',
        );
    }
    const result = await resolvePricingWriteManually({
        write_id: values['write-id'],
        operator: values.operator,
        evidence: values.evidence,
        upstream_requests_ended: true,
    });
    console.log(
        JSON.stringify(
            { operator_attestation_recorded: true, ...result, job_released: false, job_retried: false },
            null,
            2,
        ),
    );
}

main()
    .catch(() => {
        // Driver failures can contain connection credentials. Do not print them.
        console.error('未执行或未确认解除。请检查参数、数据库连接与当前持锁任务；保留现状后再核对。');
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
