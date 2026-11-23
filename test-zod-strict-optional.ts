import { z } from 'zod';

const schema = z.object({
    required: z.string(),
    optional: z.string().optional(),
    nullable: z.string().nullable(),
    nullableOptional: z.string().nullable().optional(),
}).strict();

const tests = [
    { name: 'All fields present', data: { required: 'a', optional: 'b', nullable: 'c', nullableOptional: 'd' } },
    { name: 'Optional missing', data: { required: 'a', nullable: 'c', nullableOptional: 'd' } },
    { name: 'Nullable is null', data: { required: 'a', optional: 'b', nullable: null, nullableOptional: 'd' } },
    { name: 'NullableOptional missing', data: { required: 'a', optional: 'b', nullable: 'c' } },
    { name: 'NullableOptional is null', data: { required: 'a', optional: 'b', nullable: 'c', nullableOptional: null } },
    { name: 'Extra field', data: { required: 'a', optional: 'b', nullable: 'c', nullableOptional: 'd', extra: 'e' } },
];

for (const test of tests) {
    try {
        schema.parse(test.data);
        console.log(`✓ ${test.name}: PASSED`);
    } catch (error) {
        console.log(`✗ ${test.name}: FAILED`);
        if (error instanceof z.ZodError) {
            console.log('  Errors:', JSON.stringify(error.errors, null, 2));
        }
    }
}
