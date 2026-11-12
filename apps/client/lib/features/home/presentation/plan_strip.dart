import 'package:flutter/material.dart';

import '../../../core/billing_models.dart';
import '../../../core/theme.dart';

/// Plan and quota at a glance, so the common "why is my connection limited?"
/// question is answered without opening the account screen.
///
/// Renders nothing until subscription data has loaded, so the home screen
/// never flashes an empty or wrong plan on first paint.
class PlanStrip extends StatelessWidget {
  const PlanStrip({super.key, required this.subscription, required this.onTap});

  final SubscriptionSummary? subscription;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = subscription;
    if (sub == null) return const SizedBox.shrink();

    final color = switch (sub.tier) {
      'pro' => theme.colorScheme.primary,
      'standard' => theme.colorScheme.tertiary,
      _ => theme.hintColor,
    };

    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
          side: BorderSide(color: color.withValues(alpha: 0.4)),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(sub.tier.toUpperCase(), style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 12)),
          if (sub.hasQuota) ...[
            const SizedBox(width: 8),
            Text(
              sub.isQuotaExhausted ? 'data used' : '${formatBytes(sub.bytesRemaining ?? 0)} left',
              style: theme.textTheme.bodySmall?.copyWith(
                color: sub.isQuotaExhausted ? StatusColors.failed : theme.hintColor,
              ),
            ),
          ],
          // Degraded visibility: a non-active subscription means no tunnel.
          if (!sub.isActive) ...[
            const SizedBox(width: 8),
            Text(
              sub.status,
              style: const TextStyle(color: StatusColors.failed, fontWeight: FontWeight.w600, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}