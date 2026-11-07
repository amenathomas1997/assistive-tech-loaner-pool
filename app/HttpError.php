<?php
/**
 * An error carrying an HTTP status and a stable machine-readable code.
 */

declare(strict_types=1);

namespace Loaner;

/**
 * An error carrying an HTTP status and a stable machine-readable code.
 *
 * The front controller turns these into the documented error envelope;
 * anything else becomes a generic 500, so internals never leak to a client.
 */
class HttpError extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?array $details = null,
    ) {
        parent::__construct($message);
    }
}
