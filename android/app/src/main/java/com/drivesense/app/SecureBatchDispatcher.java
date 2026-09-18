package com.drivesense.app;

import java.util.ArrayList;
import java.util.List;

/** Pure ordered per-item dispatcher; envelope validation happens before this is entered. */
final class SecureBatchDispatcher {
    interface Operation<I, O> {
        O apply(I item) throws Exception;
    }

    interface ErrorClassifier {
        String classify(Exception error);
    }

    static final class Result<O> {
        final int ordinal;
        final O value;
        final String errorCode;

        Result(int ordinal, O value, String errorCode) {
            this.ordinal = ordinal;
            this.value = value;
            this.errorCode = errorCode;
        }

        boolean succeeded() {
            return errorCode == null;
        }
    }

    private SecureBatchDispatcher() {}

    static <I, O> List<Result<O>> run(
        List<I> items,
        Operation<I, O> operation,
        ErrorClassifier classifier
    ) {
        List<Result<O>> results = new ArrayList<>(items.size());
        for (int ordinal = 0; ordinal < items.size(); ordinal += 1) {
            try {
                results.add(new Result<>(ordinal, operation.apply(items.get(ordinal)), null));
            } catch (Exception error) {
                results.add(new Result<>(ordinal, null, classifier.classify(error)));
            }
        }
        return results;
    }
}
