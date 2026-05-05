/**
 * W6 D1 — first-recharge-bonus banner.
 *
 * Pure presentational component. Server-side decides whether to render
 * (based on `User.first_recharge_bonus_granted`). The actual bonus claim
 * + race protection lives in `executeRecharge` (CAS lock inside an
 * interactive Prisma transaction); this banner is UI hint only and has
 * no behavioral coupling — hiding/showing it incorrectly does not allow
 * a user to claim the bonus twice or skip it.
 */
export function FirstRechargeBonusBanner() {
    return (
        <div
            role="note"
            data-testid="first-recharge-bonus-banner"
            style={{
                background: '#fff8e1',
                border: '1px solid #f0d785',
                color: '#7a5d00',
                padding: '10px 14px',
                borderRadius: 4,
                marginBottom: 16,
                fontSize: 13,
                lineHeight: 1.5,
            }}
        >
            <strong>🎁 首充福利</strong>
            <span style={{ marginLeft: 8 }}>
                额外赠送 20% bonus 仅限您第一次充值,机会只此一次
            </span>
        </div>
    );
}
