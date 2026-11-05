/** Error raised by the sale-rule publisher. `code` is stable for the admin UI and scheduler. */
export class SaleRulePublishError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'SaleRulePublishError';
    }
}
