package com.drivesense.app;

import java.io.File;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Fixed-memory directory discovery used only by explicit P5 compatibility
 * operations. Lifecycle jobs must consume their domain registries instead.
 */
final class DriveSenseDirectoryStream {
    interface Visitor {
        /** Return false to stop the explicit pass before end-of-stream. */
        boolean visit(Path path) throws Exception;
    }

    private DriveSenseDirectoryStream() {}

    static boolean hasRelevantEntry(File directory, DirectoryStream.Filter<Path> filter)
        throws Exception {
        if (directory == null || !directory.exists()) return false;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory.toPath(), filter)) {
            return stream.iterator().hasNext();
        }
    }

    /** Returns true only after the iterator reaches a truthful EOF. */
    static boolean visit(File directory, DirectoryStream.Filter<Path> filter, Visitor visitor)
        throws Exception {
        if (directory == null || !directory.exists()) return true;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory.toPath(), filter)) {
            for (Path path : stream) {
                if (!visitor.visit(path)) return false;
            }
        }
        return true;
    }
}
