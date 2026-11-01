import sys

if __name__ == '__main__':
    if '--qq-reader' in sys.argv:
        from qqhistory.__main__ import main
    else:
        from weflow_backend.__main__ import main
    main()
