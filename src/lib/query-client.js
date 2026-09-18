import { QueryClient } from '@tanstack/react-query';
import { subscribeP7SourceChange } from '@/lib/p7SourceChange';


export const queryClientInstance = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
			staleTime: 60 * 1000,
			gcTime: 30 * 60 * 1000,
		},
	},
});

/**
 * AUD-001 / RL-002. The one place a source change becomes a cache refresh.
 *
 * `['p7']` is the prefix every canonical key family shares, so this reaches Q1 history,
 * Q2 detail, Q4 aggregates, Q5 buckets, Q10 reducers, geometry, achievements and tag
 * context in one semantic invalidation — without a single revision appearing in a key.
 * Keys stay stable by query shape, so the cache holds one entry per live query rather
 * than one per mutation, and the 30-minute gc window cannot accumulate dead identities.
 *
 * `refetchType: 'active'` refetches what is mounted and marks the rest stale, which is
 * the semantics the surfaces want: a History page the user is looking at reloads, and a
 * Report they navigate back to later reloads then rather than in the background now.
 */
export const p7SourceChangeSubscription = subscribeP7SourceChange(() => {
	queryClientInstance
		.invalidateQueries({ queryKey: ['p7'], refetchType: 'active' })
		.catch(() => {
			// A refresh that could not be scheduled must never surface as a mutation error.
		});
});
