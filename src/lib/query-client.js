import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { notifyUserError } from '@/lib/userFeedback';

const queryLabel = (queryKey = []) => {
	const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
	return String(key || 'data').replace(/[-_]/g, ' ');
};

export const queryClientInstance = new QueryClient({
	queryCache: new QueryCache({
		onError: (error, query) => {
			if (query?.meta?.silentError === true) return;
			notifyUserError('query_error', error, {
				title: query?.meta?.errorTitle || 'Could not load data',
				description: query?.meta?.errorDescription || `Could not load ${queryLabel(query?.queryKey)}. The app will keep using anything already available.`,
				extra: {
					query_key: JSON.stringify(query?.queryKey || []),
				},
			});
		},
	}),
	mutationCache: new MutationCache({
		onError: (error, _variables, _onMutateResult, mutation) => {
			if (mutation?.meta?.silentError === true) return;
			notifyUserError('mutation_error', error, {
				title: mutation?.meta?.errorTitle || 'Could not save changes',
				description: mutation?.meta?.errorDescription,
				extra: {
					mutation_name: mutation?.meta?.name || 'unknown',
				},
			});
		},
	}),
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});
