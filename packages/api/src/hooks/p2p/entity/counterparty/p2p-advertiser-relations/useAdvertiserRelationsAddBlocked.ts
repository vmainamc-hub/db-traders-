import { useCallback } from 'react';
import useAdvertiserRelations from './useAdvertiserRelations';

/** This hook blocks advertisers of the current user by passing the advertiser id. */
const useAdvertiserRelationsAddBlocked = () => {
    const { mutate, data, ...rest } = useAdvertiserRelations();

    const addBlockedAdvertiser = useCallback(
        (id: number[]) => mutate({ payload: { add_blocked: id as [number] } }),
        [mutate]
    );

    return {
        data,
        /** Sends a request to block advertiser of the current user by passing the advertiser id. */
        mutate: addBlockedAdvertiser,
        ...rest,
    };
};

export default useAdvertiserRelationsAddBlocked;
